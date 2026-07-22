import { describe, it, expect, vi } from "vitest";
import { SearchCache, withSearchCache } from "../src/indexers/cache.js";
import type { Indexer, ReleaseQuery, TorrentCandidate } from "../src/indexers/types.js";

const candidate = (infoHash: string): TorrentCandidate => ({
  indexer: "test",
  title: "Artist - Album [FLAC]",
  infoHash,
});

/** An indexer that records every search it is actually asked to perform. */
function countingIndexer(result: TorrentCandidate[] = [candidate("a".repeat(40))]) {
  const calls: ReleaseQuery[] = [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  const indexer: Indexer & { calls: ReleaseQuery[]; release: () => void; blocking: boolean } = {
    name: "test",
    calls,
    blocking: false,
    release: () => release?.(),
    async search(query) {
      calls.push(query);
      if (indexer.blocking) await gate;
      return result;
    },
  };
  return indexer;
}

const album = (track: string): ReleaseQuery => ({ artist: "Daft Punk", album: "Discovery", track });

describe("search cache", () => {
  it("collapses every track of one album into a single indexer search", async () => {
    // The case this exists for: JIT resolution issues one /stream per track, and
    // the query is album-scoped, so all 12 were byte-identical requests.
    const inner = countingIndexer();
    const cached = withSearchCache(inner, new SearchCache());

    for (const t of ["One More Time", "Aerodynamic", "Digital Love", "Harder Better Faster"]) {
      await cached.search(album(t));
    }
    expect(inner.calls).toHaveLength(1);
  });

  it("still searches separately for a different album", async () => {
    const inner = countingIndexer();
    const cached = withSearchCache(inner, new SearchCache());

    await cached.search({ artist: "Daft Punk", album: "Discovery" });
    await cached.search({ artist: "Daft Punk", album: "Homework" });
    expect(inner.calls).toHaveLength(2);
  });

  it("shares one in-flight request between concurrent callers", async () => {
    // The player prefetches ahead of playback, so overlapping requests for the
    // same album are normal — they must not stampede the indexer.
    const inner = countingIndexer();
    inner.blocking = true;
    const cached = withSearchCache(inner, new SearchCache());

    const all = Promise.all([cached.search(album("a")), cached.search(album("b")), cached.search(album("c"))]);
    inner.release();
    const results = await all;

    expect(inner.calls).toHaveLength(1);
    expect(results.every((r) => r[0]!.infoHash === "a".repeat(40))).toBe(true);
  });

  it("expires hits after the TTL", async () => {
    let clock = 0;
    const inner = countingIndexer();
    const cached = withSearchCache(inner, new SearchCache({ ttlMs: 1_000, now: () => clock }));

    await cached.search(album("a"));
    clock = 999;
    await cached.search(album("b"));
    expect(inner.calls).toHaveLength(1);

    clock = 1_001;
    await cached.search(album("c"));
    expect(inner.calls).toHaveLength(2);
  });

  it("expires an empty result sooner than a populated one", async () => {
    // An empty answer is worth reusing but is the likeliest to go stale — same
    // reasoning as the short no-match max-age on the response itself (A-006).
    let clock = 0;
    const inner = countingIndexer([]);
    const cached = withSearchCache(inner, new SearchCache({ ttlMs: 10_000, emptyTtlMs: 1_000, now: () => clock }));

    await cached.search(album("a"));
    clock = 1_001;
    await cached.search(album("b"));
    expect(inner.calls).toHaveLength(2);
  });

  it("never caches a failure", async () => {
    // An indexer being down must not suppress the next attempt — the resolver's
    // outage-vs-no-match distinction depends on seeing it again.
    let attempts = 0;
    const flaky: Indexer = {
      name: "flaky",
      async search() {
        attempts++;
        if (attempts === 1) throw new Error("indexer down");
        return [candidate("b".repeat(40))];
      },
    };
    const cached = withSearchCache(flaky, new SearchCache());

    await expect(cached.search(album("a"))).rejects.toThrow(/indexer down/);
    await expect(cached.search(album("a"))).resolves.toHaveLength(1);
    expect(attempts).toBe(2);
  });

  it("does not let one caller's abort poison the shared search", async () => {
    const inner = countingIndexer();
    const cached = withSearchCache(inner, new SearchCache());
    const controller = new AbortController();

    const first = cached.search(album("a"), controller.signal);
    controller.abort();
    await expect(first).resolves.toHaveLength(1);
    await expect(cached.search(album("b"))).resolves.toHaveLength(1);
  });

  it("keys on the indexer as well as the query", async () => {
    const cache = new SearchCache();
    const a = countingIndexer();
    const b = countingIndexer();
    await withSearchCache({ ...a, name: "alpha" }, cache).search(album("x"));
    await withSearchCache({ ...b, name: "beta" }, cache).search(album("x"));
    expect(a.calls).toHaveLength(1);
    expect(b.calls).toHaveLength(1);
  });

  it("bounds how much it retains", async () => {
    const cache = new SearchCache({ maxEntries: 3 });
    const inner = countingIndexer();
    const cached = withSearchCache(inner, cache);
    for (let i = 0; i < 10; i++) await cached.search({ artist: "A", album: `Album ${i}` });
    expect(cache.size).toBeLessThanOrEqual(3);
  });

  it("caches candidate metadata only — no credentials reach the key", async () => {
    const cache = new SearchCache();
    const inner = countingIndexer();
    const spy = vi.spyOn(cache, "getOrLoad");
    await withSearchCache(inner, cache).search(album("a"));
    const key = spy.mock.calls[0]![0];
    expect(key).not.toMatch(/apikey|[a-f0-9]{32}/i);
  });
});
