/**
 * The search index — a read-through / write-back cache in front of MusicBrainz
 * search.
 *
 * MusicBrainz's search is a Lucene index tuned for cataloguers, not for the way
 * people type: it isn't typo-tolerant and it ranks a bare artist match above a
 * far more specific track match, so `"justin bieber baby"` surfaces the *artist*
 * rather than the song. Putting a purpose-built search engine (Meilisearch) in
 * front fixes the relevance and typo tolerance, and — because every miss
 * hydrates the index from MusicBrainz — makes the common queries progressively
 * faster.
 *
 * ## Identity, not media (Plan §6)
 *
 * What the index stores is exactly a {@link MetaPreview}: an entity-typed id, a
 * name, a poster URL, a one-line description. Public catalogue facts, keyed on
 * the MBID namespace — no hashes, no stream sources, nothing that points at a
 * copy of anything. That is why this layer is legally inert and safe to host and
 * share (unlike a *stream*-side hash cache, which is not — see the addons
 * repo's legal notes).
 *
 * ## An accelerator, never a dependency
 *
 * The contract every caller relies on: if the index is absent, slow, or
 * throwing, search still works by falling through to MusicBrainz. A cache that
 * can take the feature down with it is worse than no cache, so both methods are
 * allowed to fail and the caller treats failure as "cold". See
 * {@link searchCatalog} in `catalog.ts` for the fallthrough.
 */
import type { ContentType, MetaPreview } from "@p2p-songs/addon-sdk";

export interface SearchIndex {
  /**
   * Ranked, typo-tolerant lookup for one content type, best-first. Returns `[]`
   * for a cold/unknown query rather than throwing when it simply has nothing —
   * a throw is reserved for the index being *unreachable*, which the caller
   * treats the same way (fall through to MusicBrainz).
   */
  search(
    type: ContentType,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MetaPreview[]>;

  /**
   * Hydrate the index with previews learned from MusicBrainz. Deliberately not
   * keyed by the originating query: the engine indexes each item by its own
   * searchable text, so indexing "vampire" once also warms "vampyre",
   * "olivia vampire", and so on. Idempotent (upsert by id).
   */
  upsert(items: readonly MetaPreview[]): Promise<void>;
}

/**
 * An in-memory {@link SearchIndex} for tests and for `MEILI_URL`-less local
 * runs. It is **not** a Meilisearch stand-in — no typo tolerance, no ranked
 * relevance, no persistence. It exists to exercise the read-through / write-back
 * control flow deterministically without a live search server; the real
 * behaviour lives in {@link MeiliSearchIndex}.
 */
export class FakeSearchIndex implements SearchIndex {
  /** id → the stored preview. */
  private readonly byId = new Map<string, MetaPreview>();

  search(type: ContentType, query: string, limit: number): Promise<MetaPreview[]> {
    const tokens = normalize(query).split(" ").filter(Boolean);
    const scored: Array<{ item: MetaPreview; score: number }> = [];
    for (const item of this.byId.values()) {
      if (item.type !== type) continue;
      const haystack = normalize(`${item.name} ${item.description ?? ""}`);
      // A crude token-overlap score. Enough to prove "a warm query returns the
      // indexed item"; nothing here models Meilisearch's actual ranking.
      const score = tokens.reduce((n, t) => (haystack.includes(t) ? n + 1 : n), 0);
      if (score > 0) scored.push({ item, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return Promise.resolve(scored.slice(0, limit).map((s) => s.item));
  }

  upsert(items: readonly MetaPreview[]): Promise<void> {
    for (const item of items) this.byId.set(item.id, item);
    return Promise.resolve();
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
