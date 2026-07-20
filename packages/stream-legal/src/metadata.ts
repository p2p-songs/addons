/**
 * Recording metadata lookup: `mbid:recording:<uuid>` → "Artist – Title" (+
 * duration), which is what the legal sources are searched by. This is
 * `stream-legal`'s own discovery step (a stream addon receives only an id and
 * must figure out what to search for — like Torrentio resolving an IMDb id).
 * Behind an interface so the resolver is testable without network.
 *
 * The default implementation wraps the shared, **rate-limited**
 * `@p2p-songs/musicbrainz` client (MusicBrainz allows ≤1 req/sec per IP).
 */
import { parseMbid, type RecordingId } from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient } from "@p2p-songs/musicbrainz";

export interface RecordingMeta {
  artist: string;
  title: string;
  durationMs?: number;
}

export interface MetadataLookup {
  /** Resolve a recording id to metadata, or `undefined` if not found. */
  lookup(recordingId: RecordingId, signal?: AbortSignal): Promise<RecordingMeta | undefined>;
}

/** Default lookup, backed by the shared rate-limited MusicBrainz client. */
export class MusicBrainzLookup implements MetadataLookup {
  constructor(private readonly client: MusicBrainzClient) {}

  async lookup(recordingId: RecordingId, signal?: AbortSignal): Promise<RecordingMeta | undefined> {
    const { uuid } = parseMbid(recordingId);
    const rec = await this.client.getRecording(uuid, signal);
    if (!rec || !rec.title) return undefined;
    return { artist: rec.artist, title: rec.title, ...(rec.durationMs ? { durationMs: rec.durationMs } : {}) };
  }
}
