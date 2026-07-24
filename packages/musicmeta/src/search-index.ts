/**
 * The search index — the **curated catalogue `musicmeta` serves search from**.
 *
 * This used to be a read-through / write-back cache in front of live MusicBrainz.
 * That inverted (see `.github/docs/CATALOG_PIPELINE.md`): MusicBrainz free-text
 * search returns parodies/covers for how people actually type, and writing those
 * back inherited the junk. So the index is now built **offline** — an official-
 * only, popularity-scoped dataset (`@p2p-songs/catalog-builder`) imported into
 * Meilisearch with a zero-downtime swap — and `musicmeta` only ever **reads** it.
 *
 * That makes this a *required curated store*, not an accelerator: from the addon's
 * side it is read-only (the importer is the sole writer), and there is no
 * live-MusicBrainz fallback for search — resilience comes from the rebuildable R2
 * dataset behind the importer, not from failing over to MB's junk results.
 *
 * ## Identity, not media (Plan §6)
 *
 * What the index stores is exactly a {@link MetaPreview}: an entity-typed id, a
 * name, a poster URL, a one-line description. Public catalogue facts, keyed on
 * the MBID namespace — no hashes, no stream sources, nothing that points at a
 * copy of anything. That is why this layer is legally inert and safe to host and
 * share (unlike a *stream*-side hash cache, which is not — see the addons
 * repo's legal notes).
 */
import type { ContentType, MetaPreview } from "@p2p-songs/addon-sdk";

/** Per-type document counts of the live catalogue — surfaced to the player. */
export interface CatalogStats {
  artist: number;
  album: number;
  track: number;
  /** `artist + album + track`. */
  total: number;
}

export interface SearchIndex {
  /**
   * Ranked, typo-tolerant lookup for one content type, best-first. Returns `[]`
   * for a cold/unknown query — and also when the index does not exist yet (the
   * importer has not run), so a fresh deployment degrades to "no results" rather
   * than an error. A throw is reserved for the index being genuinely
   * *unreachable*.
   */
  search(
    type: ContentType,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MetaPreview[]>;

  /**
   * Per-type document counts of the live catalogue. Powers the player's
   * "X songs · Y albums · Z artists indexed" awareness — the catalogue is
   * curated, not exhaustive, and this sets the expectation. Zeros when the index
   * does not exist yet.
   */
  stats(signal?: AbortSignal): Promise<CatalogStats>;
}

/**
 * An in-memory {@link SearchIndex} for tests and for `MEILI_URL`-less local
 * runs. It is **not** a Meilisearch stand-in — no typo tolerance, no ranked
 * relevance, no persistence. It exists to exercise the read path deterministically
 * without a live search server; the real behaviour lives in {@link MeiliSearchIndex}.
 */
export class FakeSearchIndex implements SearchIndex {
  /** id → the stored preview. */
  private readonly byId = new Map<string, MetaPreview>();

  /** Test/dev affordance to populate the index (the importer's job in production). */
  seed(items: readonly MetaPreview[]): this {
    for (const item of items) this.byId.set(item.id, item);
    return this;
  }

  search(type: ContentType, query: string, limit: number): Promise<MetaPreview[]> {
    const tokens = normalize(query).split(" ").filter(Boolean);
    const scored: Array<{ item: MetaPreview; score: number }> = [];
    for (const item of this.byId.values()) {
      if (item.type !== type) continue;
      const haystack = normalize(`${item.name} ${item.description ?? ""}`);
      // A crude token-overlap score. Enough to prove "a query returns the
      // indexed item"; nothing here models Meilisearch's actual ranking.
      const score = tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(scored.slice(0, limit).map((s) => s.item));
  }

  stats(): Promise<CatalogStats> {
    const counts = { artist: 0, album: 0, track: 0 };
    for (const item of this.byId.values()) {
      if (item.type === "artist" || item.type === "album" || item.type === "track") counts[item.type]++;
    }
    return Promise.resolve({ ...counts, total: counts.artist + counts.album + counts.track });
  }

  /** Test affordance: how many documents are indexed. */
  get size(): number {
    return this.byId.size;
  }
}

/** Lowercase, strip punctuation, collapse whitespace. Shared by the fake + tests. */
export function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}
