/**
 * Build the curated golden NDJSON from the **MusicBrainz canonical data dump**.
 *
 * This is the production data source that replaces the per-artist API prototype
 * (`musicmeta/scripts/build-sample.mjs`). The canonical dump is CC0, already
 * deduplicated (one canonical release per recording — which dissolves the
 * edition/pressing ambiguity), and carries a `score` column that is a
 * **ListenBrainz-listen-derived popularity/priority ranking**. So a single file
 * gives us both the *content* and the *popularity scope* — no live API, no
 * ≤1 req/sec budget, no free-text search that would let parodies/covers in.
 *
 * We keep the **top-N recordings by score** (the popular, billboard-grade scope)
 * and derive three document types from exactly that set:
 *   - `track`  — one per canonical `recording_mbid`
 *   - `album`  — one per `release_mbid` seen among the kept tracks
 *   - `artist` — one per `artist_mbid`, only for single-artist credits (a joint
 *                "X feat. Y" credit has no single name to attribute, so it seeds
 *                no artist doc — but its album/track still carry the joint credit)
 *
 * `searchtext` is `"<artist> <album> <title>"` (validated: makes "baby",
 * "baby justin bieber" in any order, and "my world baby" all resolve to the song),
 * and each doc carries the popularity `score` so Meili can break relevance ties by
 * popularity (see `meili-import.ts`).
 *
 * The multi-GB download + zstd extract is done by the caller (the nightly GitHub
 * Action: `curl … | tar --zstd -x`), so this stays a pure, streaming, testable
 * transform over a local `canonical_musicbrainz_data.csv`.
 *
 * CSV schema (comma-delimited, RFC-4180 quoting), columns in order:
 *   0 id · 1 artist_credit_id · 2 artist_mbids · 3 artist_credit_name ·
 *   4 release_mbid · 5 release_name · 6 recording_mbid · 7 recording_name ·
 *   8 combined_lookup · 9 score
 */
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";

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
  /** Popularity/priority from the canonical dump; higher = more popular. */
  score: number;
  /** Artist credit — set on albums and tracks (used as a secondary searchable field). */
  description?: string;
  /** Album title — set on tracks only. */
  album?: string;
}

/** A single parsed canonical-dump row, narrowed to the fields we use. */
export interface CanonicalRow {
  artistMbids: string;
  artistCreditName: string;
  releaseMbid: string;
  releaseName: string;
  recordingMbid: string;
  recordingName: string;
  score: number;
}

const sanitize = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, "_");

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
  if (f.length < 10) return null;
  const score = Number.parseInt(f[9]!, 10);
  if (!Number.isFinite(score)) return null;
  return {
    artistMbids: f[2]!,
    artistCreditName: f[3]!,
    releaseMbid: f[4]!,
    releaseName: f[5]!,
    recordingMbid: f[6]!,
    recordingName: f[7]!,
    score,
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
 * A bounded min-heap that retains the `limit` highest-scoring rows seen, in O(1)
 * memory-per-row beyond the retained set — so we can scan the whole multi-GB dump
 * (tens of millions of rows) while only ever holding the top-N in memory.
 */
export class TopN {
  private readonly heap: CanonicalRow[] = [];
  constructor(private readonly limit: number) {}

  push(row: CanonicalRow): void {
    if (this.limit <= 0) return;
    if (this.heap.length < this.limit) {
      this.heap.push(row);
      this.bubbleUp(this.heap.length - 1);
    } else if (row.score > this.heap[0]!.score) {
      this.heap[0] = row;
      this.bubbleDown(0);
    }
  }

  /** The retained rows (unordered). */
  values(): CanonicalRow[] {
    return this.heap;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.heap[i]!.score >= this.heap[parent]!.score) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  private bubbleDown(i: number): void {
    const n = this.heap.length;
    for (;;) {
      const l = 2 * i + 1;
      const r = 2 * i + 2;
      let smallest = i;
      if (l < n && this.heap[l]!.score < this.heap[smallest]!.score) smallest = l;
      if (r < n && this.heap[r]!.score < this.heap[smallest]!.score) smallest = r;
      if (smallest === i) break;
      this.swap(i, smallest);
      i = smallest;
    }
  }

  private swap(a: number, b: number): void {
    const tmp = this.heap[a]!;
    this.heap[a] = this.heap[b]!;
    this.heap[b] = tmp;
  }
}

/**
 * Derive the unified artist/album/track documents from a set of canonical rows.
 * Deduplicates per entity, keeping the highest-scoring occurrence of each — so an
 * album's/artist's `score` reflects its most popular track.
 */
export function docsFromRows(rows: Iterable<CanonicalRow>): CatalogDoc[] {
  const artists = new Map<string, CatalogDoc>();
  const albums = new Map<string, CatalogDoc>();
  const tracks = new Map<string, CatalogDoc>();

  const keepMax = (map: Map<string, CatalogDoc>, key: string, make: () => CatalogDoc, score: number) => {
    const existing = map.get(key);
    if (!existing || score > existing.score) map.set(key, make());
  };

  for (const row of rows) {
    const artist = row.artistCreditName;

    if (row.recordingMbid) {
      const id = `mbid:recording:${row.recordingMbid}`;
      keepMax(tracks, row.recordingMbid, () => ({
        docId: sanitize(id),
        id,
        type: "track",
        name: row.recordingName,
        description: artist,
        album: row.releaseName,
        searchtext: `${artist} ${row.releaseName} ${row.recordingName}`,
        score: row.score,
      }), row.score);
    }

    if (row.releaseMbid) {
      const id = `mbid:release:${row.releaseMbid}`;
      keepMax(albums, row.releaseMbid, () => ({
        docId: sanitize(id),
        id,
        type: "album",
        name: row.releaseName,
        description: artist,
        searchtext: `${artist} ${row.releaseName}`,
        score: row.score,
      }), row.score);
    }

    // Only single-artist credits seed an artist doc: a joint "X feat. Y" credit
    // has no single name to attribute to either MBID.
    const mbids = parseArtistMbids(row.artistMbids);
    if (mbids.length === 1 && mbids[0]) {
      const id = `mbid:artist:${mbids[0]}`;
      keepMax(artists, mbids[0], () => ({
        docId: sanitize(id),
        id,
        type: "artist",
        name: artist,
        searchtext: artist,
        score: row.score,
      }), row.score);
    }
  }

  return [...artists.values(), ...albums.values(), ...tracks.values()];
}

/** Serialize documents to NDJSON (one JSON object per line, trailing newline). */
export function serializeNdjson(docs: CatalogDoc[]): string {
  return docs.map((d) => JSON.stringify(d)).join("\n") + "\n";
}

export interface BuildOptions {
  /** Keep the top-N recordings by popularity score. */
  limit: number;
  /** Progress callback, invoked every `progressEvery` rows scanned. */
  onProgress?: (rowsScanned: number) => void;
  progressEvery?: number;
}

/**
 * Stream `canonical_musicbrainz_data.csv`, keep the top-N rows by score, and
 * return the curated NDJSON. Memory is bounded to the retained set regardless of
 * how large the dump is.
 */
export async function buildCatalog(csvPath: string, opts: BuildOptions): Promise<string> {
  const top = new TopN(opts.limit);
  const progressEvery = opts.progressEvery ?? 1_000_000;
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
    if (!row) continue;
    top.push(row);
    if (++scanned % progressEvery === 0) opts.onProgress?.(scanned);
  }
  opts.onProgress?.(scanned);

  return serializeNdjson(docsFromRows(top.values()));
}
