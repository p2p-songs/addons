/**
 * Build the curated golden NDJSON by joining two CC0 sources:
 *
 *  - **Popularity scope** — ListenBrainz sitewide "top artists" (`listenbrainz.ts`):
 *    the ~1000 most-listened artists, with a real listen count each. This is what
 *    makes the catalogue billboard-grade and keeps parodies/long-tail noise out —
 *    only genuinely popular artists are in scope at all.
 *  - **Content/breadth** — the **MusicBrainz canonical data dump**
 *    (`canonical_musicbrainz_data.csv`, CC0): deduplicated (one canonical release
 *    per recording), streamed offline. We keep only the rows whose **primary
 *    artist MBID is in the popularity scope**, giving each popular artist's whole
 *    catalogue without any per-artist API calls.
 *
 * (An earlier version used the canonical dump's `score` column as the popularity
 * signal — it is not one; it behaves like a row ordinal, so top-N-by-score
 * returned ~random obscure recordings. The listen-count join is the fix.)
 *
 * Each document carries the artist's **listen count as its `score`**, so Meili
 * ranks a top artist's songs above a #900 artist's on a relevance tie (see
 * `meili-import.ts`). `searchtext` is `"<artist> <album> <title>"` (validated:
 * makes "baby", "baby justin bieber" in any order, and "my world baby" all
 * resolve to the song). Albums/tracks carry a Cover Art Archive poster derived
 * from their canonical release MBID.
 *
 * The multi-GB dump download + zstd extract is done by the caller (the nightly
 * GitHub Action), so this stays a streaming transform over a local CSV.
 *
 * CSV schema (comma-delimited, RFC-4180 quoting), columns in order:
 *   0 id · 1 artist_credit_id · 2 artist_mbids · 3 artist_credit_name ·
 *   4 release_mbid · 5 release_name · 6 recording_mbid · 7 recording_name ·
 *   8 combined_lookup · 9 score
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { ArtistPopularity } from "./listenbrainz.js";

export type DocType = "artist" | "album" | "track";

export interface CatalogDoc {
  /** Meili primary key — the id with non-alphanumerics folded to `_`. */
  docId: string;
  /** Entity-typed id: `mbid:artist:` / `mbid:release:` / `mbid:recording:`. */
  id: string;
  type: DocType;
  name: string;
  /** `"<artist> <album> <title>"` (or a prefix of it, by type) — the ranked field. */
  searchtext: string;
  /** The artist's ListenBrainz listen count — the popularity signal. */
  score: number;
  /** Artist credit — set on albums and tracks. */
  description?: string;
  /** Album title — set on tracks only. */
  album?: string;
  /**
   * The track's release id (`mbid:release:<uuid>`) — set on tracks only. This is
   * the **album context** a stream addon needs to resolve a track *search* hit
   * playably: a bare recording is on many releases, so without it discovery is
   * artist+title alone and file selection is a guess. With it, the stream addon
   * scopes the search to this release and picks the file by the recording's
   * position on it — the same context a track played from an album carries.
   */
  releaseId?: string;
  /** Cover Art Archive poster URL — set on albums and tracks. */
  poster?: string;
}

/** A single parsed canonical-dump row, narrowed to the fields we use. */
export interface CanonicalRow {
  artistMbids: string;
  artistCreditName: string;
  releaseMbid: string;
  releaseName: string;
  recordingMbid: string;
  recordingName: string;
}

const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

/** Cover Art Archive front-cover URL for a release (no API call; 302-redirects). */
const coverUrl = (releaseMbid: string): string =>
  `https://coverartarchive.org/release/${releaseMbid}/front-500`;

/**
 * Parse one RFC-4180 CSV line into fields. Handles `"`-quoted fields (which may
 * contain commas — "Earth, Wind & Fire") and `""` escapes. The canonical dump has
 * no embedded newlines in fields, so line-at-a-time parsing is correct here.
 */
export function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      quoted = true;
    } else if (c === ",") {
      out.push(field);
      field = "";
    } else {
      field += c;
    }
  }
  out.push(field);
  return out;
}

/** Map a raw CSV line to a {@link CanonicalRow}, or `null` if it's malformed. */
export function rowFromCsvLine(line: string): CanonicalRow | null {
  const f = parseCsvLine(line);
  if (f.length < 8) return null;
  const recordingMbid = f[6]!;
  if (!recordingMbid) return null; // header row / garbage
  return {
    artistMbids: f[2]!,
    artistCreditName: f[3]!,
    releaseMbid: f[4]!,
    releaseName: f[5]!,
    recordingMbid,
    recordingName: f[7]!,
  };
}

/** Split the Postgres-array `artist_mbids` literal (`{uuid,uuid}`) into MBIDs. */
export function parseArtistMbids(raw: string): string[] {
  return raw
    .replace(/^\{/, "")
    .replace(/\}$/, "")
    .split(",")
    .map((s) => s.trim().replace(/^"|"$/g, ""))
    .filter((s) => s.length > 0);
}

/**
 * Derive the unified artist/album/track documents.
 *
 * Artist docs come straight from the popularity `scope` (clean ListenBrainz names
 * and listen counts, one per scoped artist). Album/track docs come from the
 * canonical `rows` whose **primary** artist is in scope, deduplicated per entity.
 * A doc's base `score` is its artist's listen count; a track that is itself in the
 * `recordingPopularity` map gets that added on top, so the songs people play most
 * outrank an artist's own album cuts / live / remix versions.
 */
export function docsFromRows(
  rows: Iterable<CanonicalRow>,
  scope: Map<string, ArtistPopularity>,
  recordingPopularity: Map<string, number> = new Map(),
): CatalogDoc[] {
  const albums = new Map<string, CatalogDoc>();
  const tracks = new Map<string, CatalogDoc>();

  for (const row of rows) {
    // Scope on the *primary* (first) artist MBID — a track only enters the
    // catalogue as part of its own artist's discography, not every guest's.
    const primary = parseArtistMbids(row.artistMbids)[0];
    if (!primary) continue;
    const artist = scope.get(primary);
    if (!artist) continue;
    const score = artist.listenCount;
    const credit = row.artistCreditName || artist.name;

    if (row.recordingMbid && !tracks.has(row.recordingMbid)) {
      const id = `mbid:recording:${row.recordingMbid}`;
      tracks.set(row.recordingMbid, {
        docId: sanitize(id),
        id,
        type: "track",
        name: row.recordingName,
        description: credit,
        album: row.releaseName,
        searchtext: `${credit} ${row.releaseName} ${row.recordingName}`,
        score: score + (recordingPopularity.get(row.recordingMbid) ?? 0),
        ...(row.releaseMbid ? { releaseId: `mbid:release:${row.releaseMbid}`, poster: coverUrl(row.releaseMbid) } : {}),
      });
    }

    if (row.releaseMbid && !albums.has(row.releaseMbid)) {
      const id = `mbid:release:${row.releaseMbid}`;
      albums.set(row.releaseMbid, {
        docId: sanitize(id),
        id,
        type: "album",
        name: row.releaseName,
        description: credit,
        searchtext: `${credit} ${row.releaseName}`,
        score,
        poster: coverUrl(row.releaseMbid),
      });
    }
  }

  const artists: CatalogDoc[] = [...scope.values()].map((a) => {
    const id = `mbid:artist:${a.mbid}`;
    return { docId: sanitize(id), id, type: "artist", name: a.name, searchtext: a.name, score: a.listenCount };
  });

  return [...artists, ...albums.values(), ...tracks.values()];
}

/** Serialize documents to NDJSON (one JSON object per line, trailing newline). */
export function serializeNdjson(docs: CatalogDoc[]): string {
  return docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
}

export interface BuildOptions {
  /** The popularity scope — top artists keyed by MBID (from `fetchTopArtists`). */
  artists: Map<string, ArtistPopularity>;
  /** Per-song popularity boost — `recording_mbid → listens` (from `fetchTopRecordings`). */
  recordingPopularity?: Map<string, number>;
  /** Progress callback, invoked every `progressEvery` rows scanned. */
  onProgress?: (rowsScanned: number, kept: number) => void;
  progressEvery?: number;
}

/**
 * Stream `canonical_musicbrainz_data.csv`, keep the rows whose primary artist is
 * in the popularity scope, and return the curated NDJSON. Memory is bounded to
 * the kept set (the scoped artists' catalogues), not the whole dump.
 */
export async function buildCatalog(csvPath: string, opts: BuildOptions): Promise<string> {
  const progressEvery = opts.progressEvery ?? 1_000_000;
  const scopeMbids = opts.artists;
  const kept: CanonicalRow[] = [];
  let scanned = 0;
  let header = true;

  const rl = createInterface({ input: createReadStream(csvPath), crlfDelay: Infinity });
  for await (const line of rl) {
    if (header) {
      header = false; // first line is the column header
      continue;
    }
    if (line.length === 0) continue;
    const row = rowFromCsvLine(line);
    if (row) {
      const primary = parseArtistMbids(row.artistMbids)[0];
      if (primary && scopeMbids.has(primary)) kept.push(row);
    }
    if (++scanned % progressEvery === 0) opts.onProgress?.(scanned, kept.length);
  }
  opts.onProgress?.(scanned, kept.length);

  return serializeNdjson(docsFromRows(kept, opts.artists, opts.recordingPopularity));
}
