/**
 * Turn a `/stream` request into everything discovery and file selection need.
 *
 * A stream addon receives only ids — it must work out *what to search for*
 * (Torrentio resolving an IMDb id to a title). Bitbop needs more than
 * `stream-legal` does, because it selects a file inside a whole-album torrent
 * (Plan §2a):
 *
 * - **artist + album title** → what to query indexers for;
 * - **the exact track's disc + position** → how to pick its file deterministically
 *   when album context is present;
 * - **track title + duration** → the fuzzy fallback when it isn't.
 *
 * Album context (`releaseId` / `trackId`) is optional. With it, resolution is
 * deterministic; without it we pick a canonical release the recording appears on
 * and fall back to fuzzy matching (Plan §2a). Behind an interface so the
 * resolver is testable without network.
 */
import { parseMbid, type StreamRequest } from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient, MbTrack } from "@p2p-songs/musicbrainz";

/** The specific track we're resolving, with whatever context we could establish. */
export interface TrackContext {
  /** The artist credited for *this track* — what discovery searches by. */
  artist: string;
  /**
   * The release's credited artist, when it differs (compilations credit
   * "Various Artists"). Used for album *grouping*, never for searching: a
   * bingeGroup must be stable across an album, so it can't key on a per-track
   * artist, and a search must be specific, so it can't key on "Various Artists".
   */
  albumArtist?: string;
  /** Album/release title to search indexers by, when we have one. */
  album?: string;
  /** The track/recording title. */
  title: string;
  durationMs?: number;
  /** 1-based disc (medium) number, when album context resolved it. */
  disc?: number;
  /** Track position within the disc — may be free text ("A4"). Present with album context. */
  position?: string;
  /** True when disc+position came from real album context (deterministic selection is possible). */
  hasAlbumContext: boolean;
}

export interface MetadataLookup {
  resolve(request: StreamRequest, signal?: AbortSignal): Promise<TrackContext | undefined>;
}

export class MusicBrainzLookup implements MetadataLookup {
  constructor(private readonly client: MusicBrainzClient) {}

  async resolve(request: StreamRequest, signal?: AbortSignal): Promise<TrackContext | undefined> {
    const { uuid: recordingUuid } = parseMbid(request.recordingId);

    // With a release id, pull the album and locate this recording's track on it —
    // that's the disc+position that makes file selection deterministic.
    if (request.releaseId) {
      const { uuid: releaseUuid } = parseMbid(request.releaseId);
      const release = await this.client.getRelease(releaseUuid, signal);
      if (release) {
        const track = matchTrack(release.tracks, recordingUuid, request.trackId);
        if (track) {
          return {
            // The *track's* artist drives discovery. On a compilation the
            // release is credited to "Various Artists", and searching an
            // indexer for that finds nothing — measured live against Prowlarr.
            artist: track.artist ?? release.artist,
            albumArtist: release.artist,
            album: release.title,
            title: track.title,
            ...(track.durationMs ? { durationMs: track.durationMs } : {}),
            disc: track.disc,
            position: track.position,
            hasAlbumContext: true,
          };
        }
        // The recording wasn't on the named release (bad context) — fall through
        // to the recording-only path rather than trusting a mismatch.
      }
    }

    // No (usable) album context: resolve the bare recording and match fuzzily.
    const rec = await this.client.getRecording(recordingUuid, signal);
    if (!rec || !rec.title) return undefined;
    return {
      artist: rec.artist,
      title: rec.title,
      ...(rec.durationMs ? { durationMs: rec.durationMs } : {}),
      hasAlbumContext: false,
    };
  }
}

/** Prefer the exact trackId; else the recording's appearance on the release. */
function matchTrack(tracks: MbTrack[], recordingUuid: string, trackId?: string): MbTrack | undefined {
  if (trackId) {
    const { uuid: trackUuid } = parseMbid(trackId);
    const byTrack = tracks.find((t) => t.trackId === trackUuid);
    if (byTrack) return byTrack;
  }
  return tracks.find((t) => t.recordingId === recordingUuid);
}
