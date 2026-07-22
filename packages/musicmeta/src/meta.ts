/**
 * Meta (full detail for one item). Keyed off the id's *entity* (not the route
 * `type`) so identity is authoritative: a release → an `album` meta whose
 * `tracks[]` carry both the `recordingId` (streamable) and the `trackId`
 * (album-context, with disc + free-text position) — exactly what feeds the
 * queue and what `stream-legal`/`stream-debrid` resolve against.
 */
import {
  parseMbid,
  formatMbid,
  type MetaDetail,
  type AlbumTrack,
  type ArtistId,
  type ReleaseId,
  type RecordingId,
  type TrackId,
} from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient, MbTrack } from "@p2p-songs/musicbrainz";
import { releaseFrontCover } from "./coverart.js";

export interface MetaDeps {
  mb: MusicBrainzClient;
}

/** Resolve a content id to full metadata, or `undefined` if the entity isn't found. */
export async function metaFor(id: string, deps: MetaDeps, signal?: AbortSignal): Promise<MetaDetail | undefined> {
  const { entity, uuid } = parseMbid(id);
  switch (entity) {
    case "artist": {
      const a = await deps.mb.getArtist(uuid, signal);
      if (!a) return undefined;
      return { type: "artist", id: formatMbid("artist", a.id) as ArtistId, name: a.name };
    }
    case "release": {
      const r = await deps.mb.getAlbum(uuid, signal);
      if (!r) return undefined;
      return {
        type: "album",
        id: formatMbid("release", r.id) as ReleaseId,
        name: r.title,
        poster: releaseFrontCover(r.id),
        ...(r.artist ? { artistName: r.artist } : {}),
        ...(r.date ? { releaseDate: r.date } : {}),
        tracks: r.tracks.map((t) => toAlbumTrack(t, r.artist)),
      };
    }
    case "recording": {
      const r = await deps.mb.getRecording(uuid, signal);
      if (!r) return undefined;
      return {
        type: "track",
        id: formatMbid("recording", r.id) as RecordingId,
        name: r.title,
        ...(r.artist ? { artistName: r.artist } : {}),
      };
    }
    case "track":
      // A track id is album-context only; it is never addressed on its own.
      return undefined;
  }
}

function toAlbumTrack(t: MbTrack, albumArtist: string): AlbumTrack {
  const track: AlbumTrack = {
    recordingId: formatMbid("recording", t.recordingId) as RecordingId,
    trackId: formatMbid("track", t.trackId) as TrackId,
    title: t.title,
    disc: t.disc,
    position: t.position,
  };
  if (typeof t.durationMs === "number") track.durationMs = t.durationMs;
  if (albumArtist) track.artistName = albumArtist;
  return track;
}
