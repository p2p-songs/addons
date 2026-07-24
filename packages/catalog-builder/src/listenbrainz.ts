/**
 * The **popularity source**: ListenBrainz sitewide "top artists" statistics
 * (CC0). This is what makes the catalogue billboard-grade — the artists people
 * actually listen to most, ranked by real listen counts, not an arbitrary id.
 *
 * Why the artist level: ListenBrainz's sitewide stats are hard-capped at the top
 * ~1000 entries per type, which is too thin to be a catalogue on its own. But the
 * top ~1000 *artists* is a perfect popularity **scope** — we then take breadth
 * from the MusicBrainz canonical dump, keeping only those artists' catalogues
 * (see `build.ts`). Each artist's listen count becomes the ranking score applied
 * to all their songs/albums, so a top artist outranks a long-tail one.
 *
 * The endpoint (`/1/stats/sitewide/artists`) returns at most 1000 rows per page
 * *and* refuses offsets past ~1000, so pagination naturally terminates; we stop
 * on the first short/empty page regardless.
 */

export interface ArtistPopularity {
  /** MusicBrainz artist MBID. */
  mbid: string;
  name: string;
  /** All-time listen count — the popularity signal. */
  listenCount: number;
}

interface SitewideArtistRow {
  artist_name?: string;
  artist_mbid?: string | null;
  artist_mbids?: (string | null)[] | null;
  listen_count?: number;
}

export interface FetchTopArtistsOptions {
  /** How many top artists to keep (the popularity scope). */
  limit: number;
  /** ListenBrainz API base (default the public instance). */
  baseUrl?: string;
  /** Stats window: `all_time` (default), `year`, `month`, `week`. */
  range?: string;
  /** Rows per request; the API caps this at 1000. */
  pageSize?: number;
  /** Politeness delay between requests, ms (default 250). */
  delayMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Progress callback (artists collected so far). */
  onProgress?: (collected: number) => void;
}

const DEFAULT_BASE = "https://api.listenbrainz.org";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalize the MBID from either the singular or array field. */
function rowMbid(row: SitewideArtistRow): string | undefined {
  if (row.artist_mbid) return row.artist_mbid;
  const first = row.artist_mbids?.find((m): m is string => typeof m === "string" && m.length > 0);
  return first;
}

/**
 * Fetch the top artists by all-time listens, newest-first, as a map keyed by
 * MBID (so a build can test membership in O(1)). Rows without an MBID — listens
 * ListenBrainz could not map to MusicBrainz — are skipped, since we key the
 * catalogue on MBIDs.
 */
export async function fetchTopArtists(opts: FetchTopArtistsOptions): Promise<Map<string, ArtistPopularity>> {
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const range = opts.range ?? "all_time";
  const pageSize = Math.min(opts.pageSize ?? 1000, 1000);
  const delayMs = opts.delayMs ?? 250;
  const doFetch = opts.fetchImpl ?? fetch;

  const out = new Map<string, ArtistPopularity>();
  for (let offset = 0; out.size < opts.limit; offset += pageSize) {
    const url = `${base}/1/stats/sitewide/artists?count=${pageSize}&offset=${offset}&range=${range}`;
    const res = await doFetch(url);
    if (!res.ok) throw new Error(`listenbrainz ${url} → ${res.status}`);
    const body = (await res.json()) as { payload?: { artists?: SitewideArtistRow[] } };
    const rows = body.payload?.artists ?? [];
    if (rows.length === 0) break; // past the API's ~1000 ceiling, or exhausted

    for (const row of rows) {
      if (out.size >= opts.limit) break;
      const mbid = rowMbid(row);
      const name = row.artist_name?.trim();
      if (!mbid || !name || out.has(mbid)) continue;
      out.set(mbid, { mbid, name, listenCount: row.listen_count ?? 0 });
    }
    opts.onProgress?.(out.size);
    if (rows.length < pageSize) break; // last page
    if (delayMs > 0) await sleep(delayMs);
  }
  return out;
}
