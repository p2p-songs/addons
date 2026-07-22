/**
 * Catalog (search). Turns a `search` query into `metaPreview[]`, each with the
 * correct entity-typed id for its content type — `artist`→`mbid:artist:`,
 * `album`→`mbid:release:`, `track`→`mbid:recording:` (the streamable identity).
 * The SDK's discriminated-union schema rejects any type↔id mismatch, so this is
 * where honest identity starts.
 */
import {
  formatMbid,
  parseMbid,
  type ContentType,
  type MetaPreview,
  type ArtistId,
  type ReleaseId,
  type RecordingId,
} from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient } from "@p2p-songs/musicbrainz";
import { releaseFrontCover } from "./coverart.js";

export interface CatalogDeps {
  mb: MusicBrainzClient;
  limit?: number;
}

/**
 * An artist's discography, as album previews.
 *
 * This is what makes artist *search* lead anywhere: a search result is only an
 * id and a name, so without a way to go id → albums, finding an artist is a
 * dead end. Ids are `mbid:release:`, the same shape album search emits, so the
 * player's existing album screen handles them with no special casing.
 */
export async function artistAlbumsCatalog(
  artistId: string,
  deps: CatalogDeps,
  signal?: AbortSignal,
): Promise<MetaPreview[]> {
  const { uuid } = parseMbid(artistId);
  if (!uuid) return [];
  const releases = await deps.mb.browseArtistReleases(uuid, deps.limit ?? 25, signal);
  return releases.map((r) => ({
    type: "album",
    id: formatMbid("release", r.id) as ReleaseId,
    name: r.title,
    poster: releaseFrontCover(r.id),
    // The year disambiguates a re-recording from the original far better than
    // the artist name does here — every row shares the artist already.
    ...(r.date ? { description: r.date.slice(0, 4) } : r.artist ? { description: r.artist } : {}),
  }));
}

export async function searchCatalog(
  type: ContentType,
  search: string,
  deps: CatalogDeps,
  signal?: AbortSignal,
): Promise<MetaPreview[]> {
  const limit = deps.limit ?? 25;
  switch (type) {
    case "artist": {
      const artists = await deps.mb.searchArtists(search, limit, signal);
      return artists.map((a) => ({
        type: "artist",
        id: formatMbid("artist", a.id) as ArtistId,
        name: a.name,
      }));
    }
    case "album": {
      const releases = await deps.mb.searchReleases(search, limit, signal);
      return releases.map((r) => ({
        type: "album",
        id: formatMbid("release", r.id) as ReleaseId,
        name: r.title,
        poster: releaseFrontCover(r.id),
        ...(r.artist ? { description: r.artist } : {}),
      }));
    }
    case "track": {
      const recordings = await deps.mb.searchRecordings(search, limit, signal);
      return recordings.map((r) => ({
        type: "track",
        id: formatMbid("recording", r.id) as RecordingId,
        name: r.title,
        ...(r.artist ? { description: r.artist } : {}),
      }));
    }
    case "playlist":
      return [];
  }
}
