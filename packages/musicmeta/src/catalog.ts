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
import { releaseFrontCover, releaseGroupFrontCover } from "./coverart.js";
import type { SearchIndex } from "./search-index.js";

export interface CatalogDeps {
  mb: MusicBrainzClient;
  limit?: number;
  /**
   * Optional search accelerator (Meilisearch in production). When absent,
   * `searchCatalog` is exactly the direct-MusicBrainz behaviour it always was —
   * the index is purely additive, so a deployment without `MEILI_URL` is
   * unaffected.
   */
  index?: SearchIndex;
  /**
   * Serve from the index only when it returns at least this many hits;
   * otherwise treat the query as cold and go to MusicBrainz (which also
   * re-hydrates). Guards against answering with one stale document when MB would
   * return a full page. Default {@link DEFAULT_MIN_INDEX_HITS}.
   */
  minIndexHits?: number;
}

/**
 * Below this many index hits, a query is "cold enough" to prefer MusicBrainz.
 * Low, not zero: a genuinely niche query may only ever have a couple of real
 * matches, and re-hitting MB for every one of those forever would defeat the
 * cache. The floor mainly stops a half-warmed index from shadowing MB's fuller
 * result on popular queries.
 */
export const DEFAULT_MIN_INDEX_HITS = 3;

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
  const albums = await deps.mb.artistDiscography(uuid, deps.limit ?? 25, signal);
  return albums.map((a) => ({
    type: "album",
    id: formatMbid("release", a.id) as ReleaseId,
    name: a.title,
    // Group art, not the representative pressing's — a pressing often has none.
    poster: releaseGroupFrontCover(a.releaseGroupId),
    // The year disambiguates a re-recording from the original far better than
    // the artist name does here — every row shares the artist already.
    ...(a.date ? { description: a.date.slice(0, 4) } : a.artist ? { description: a.artist } : {}),
  }));
}

/**
 * Catalog search with the index in the loop: **read-through** (ask the index
 * first) and **write-back** (hydrate the index from MusicBrainz on a miss).
 *
 * The index is an accelerator, never a dependency — a failed *read* falls
 * through to MusicBrainz, and a failed *write* is swallowed off the response
 * path (a search should never fail, or even wait, because caching it did). With
 * no index configured this is a straight MusicBrainz search, unchanged.
 */
export async function searchCatalog(
  type: ContentType,
  search: string,
  deps: CatalogDeps,
  signal?: AbortSignal,
): Promise<MetaPreview[]> {
  const limit = deps.limit ?? 25;
  const { index } = deps;

  if (index) {
    try {
      const hits = await index.search(type, search, limit, signal);
      if (hits.length >= (deps.minIndexHits ?? DEFAULT_MIN_INDEX_HITS)) return hits;
    } catch {
      // Index unreachable → treat as cold and let MusicBrainz answer.
    }
  }

  const fresh = await searchMusicBrainz(type, search, deps, signal);

  if (index && fresh.length > 0) {
    // Hydrate off the response path: don't make the caller wait on (or fail
    // from) the write. In a long-lived server this settles right after we reply.
    void index.upsert(fresh).catch(() => {});
  }

  return fresh;
}

/** The original MusicBrainz search — the source of truth the index is fed from. */
async function searchMusicBrainz(
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
