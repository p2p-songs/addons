import { describe, it, expect, vi } from "vitest";
import { resolveStreams, rankCandidates, keepRelevantCandidates } from "../src/resolve.js";
import type { ResolveDeps } from "../src/resolve.js";
import { parseConfig, type BitbopConfig } from "../src/config.js";
import type { MetadataLookup, TrackContext } from "../src/metadata.js";
import type { Indexer, ReleaseQuery, TorrentCandidate } from "../src/indexers/types.js";
import type { CacheResult, DebridProvider, ResolvedLink } from "../src/debrid/types.js";
import { DebridError } from "../src/debrid/types.js";

const RID = "mbid:recording:11111111-1111-1111-1111-111111111111";

const config = (over: Partial<BitbopConfig> = {}): BitbopConfig =>
  parseConfig({
    debrid: { provider: "realdebrid", apiKey: "RDKEY" },
    indexers: [{ url: "https://jackett.example/t", apiKey: "IXKEY" }],
    ...over,
  })!;

const track: TrackContext = {
  artist: "Daft Punk",
  album: "Discovery",
  title: "Digital Love",
  disc: 1,
  position: "3",
  hasAlbumContext: true,
};

const metadataOf = (t: TrackContext | undefined): MetadataLookup => ({ resolve: async () => t });

const indexerOf = (candidates: TorrentCandidate[] | (() => Promise<TorrentCandidate[]>)): Indexer => ({
  name: "fake",
  search: typeof candidates === "function" ? candidates : async () => candidates,
});

const HASH = "0123456789abcdef0123456789abcdef01234567";
const candidate: TorrentCandidate = { indexer: "fake", title: "Daft Punk - Discovery [FLAC]", infoHash: HASH, seeders: 50, format: "FLAC" };

const albumFiles = [
  { id: "0", path: "Discovery/01 - One More Time.flac", sizeBytes: 40_000_000 },
  { id: "1", path: "Discovery/02 - Aerodynamic.flac", sizeBytes: 35_000_000 },
  { id: "2", path: "Discovery/03 - Digital Love.flac", sizeBytes: 50_000_000 },
];

const providerOf = (over: Partial<DebridProvider> & { cache?: CacheResult; link?: ResolvedLink } = {}): DebridProvider => ({
  id: "realdebrid",
  // Optional on the port: only present when a test opts into the bulk pre-check.
  ...(over.listCached ? { listCached: over.listCached } : {}),
  ...(over.startDownload ? { startDownload: over.startDownload } : {}),
  checkCache: over.checkCache ?? (async () => over.cache ?? { cached: true, files: albumFiles }),
  resolveFile: over.resolveFile ?? (async () => over.link ?? { url: "https://rd.example/dl/digital-love.flac", filename: "03 - Digital Love.flac", sizeBytes: 50_000_000 }),
});

const deps = (over: Partial<ResolveDeps> = {}): ResolveDeps => ({
  metadata: over.metadata ?? metadataOf(track),
  indexers: over.indexers ?? [indexerOf([candidate])],
  provider: over.provider ?? providerOf(),
});

describe("resolveStreams — happy path", () => {
  it("discovers, picks the right file by position, and resolves a direct link", async () => {
    const result = await resolveStreams({ recordingId: RID, releaseId: "mbid:release:22222222-2222-2222-2222-222222222222" }, config(), deps());
    expect(result.outage).toBe(false);
    expect(result.streams).toHaveLength(1);
    const [stream] = result.streams;
    expect(stream!.url).toBe("https://rd.example/dl/digital-love.flac");
    expect(stream!.name).toContain("FLAC");
    expect(stream!.behaviorHints?.filename).toBe("03 - Digital Love.flac");
    // album grouping present for gapless
    expect(stream!.behaviorHints?.bingeGroup).toContain("bitbop-");
  });

  it("passes the caller's debrid key through to the provider, never a default", async () => {
    const seenKeys: string[] = [];
    const provider = providerOf({
      checkCache: async (_h, key) => (seenKeys.push(key), { cached: true, files: albumFiles }),
      resolveFile: async (_h, _f, key) => (seenKeys.push(key), { url: "https://rd.example/dl/x.flac" }),
    });
    await resolveStreams({ recordingId: RID }, config(), deps({ provider }));
    expect(seenKeys.every((k) => k === "RDKEY")).toBe(true);
  });
});

describe("resolveStreams — reusing what the account already holds", () => {
  it("probes an already-downloaded torrent without adding anything, and threads its handle", async () => {
    // The second-and-later tracks of an album take this path: track 1 left the
    // torrent on the account, so the rest of the album costs no writes at all.
    const seen: { check?: string; resolve?: string } = {};
    const provider = providerOf({
      listCached: async () => new Map([[candidate.infoHash.toLowerCase(), "T-EXISTING"]]),
      checkCache: async (ref) => ((seen.check = ref.handle), { cached: true, files: albumFiles, handle: ref.handle }),
      resolveFile: async (ref) => ((seen.resolve = ref.handle), { url: "https://rd.example/dl/x.flac" }),
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ provider }));

    expect(result.streams).toHaveLength(1);
    expect(seen.check).toBe("T-EXISTING");
    expect(seen.resolve).toBe("T-EXISTING");
  });

  it("tries the account's own torrents before spending an add on anything else", async () => {
    const known = { ...candidate, infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const unknown = { ...candidate, infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", seeders: 9999 };
    const order: string[] = [];
    const provider = providerOf({
      listCached: async () => new Map([[known.infoHash, "T-KNOWN"]]),
      checkCache: async (ref) => (order.push(ref.infoHash), { cached: true, files: albumFiles, handle: ref.handle }),
    });
    // `unknown` outranks `known` on seeders, yet the free probe still goes first.
    await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([unknown, known])], provider }));
    expect(order[0]).toBe(known.infoHash);
  });

  it("falls back to probing when the bulk pre-check fails", async () => {
    const provider = providerOf({
      listCached: async () => {
        throw new DebridError("rate limited", false);
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ provider }));
    expect(result.streams).toHaveLength(1); // an optimization failing is not an outage
  });

  it("still reports an outage when the pre-check rejects the key", async () => {
    const provider = providerOf({
      listCached: async () => {
        throw new DebridError("auth failed", true);
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ provider }));
    expect(result.outage).toBe(true);
  });
});

describe("resolveStreams — failure semantics", () => {
  it("reports an outage when every indexer fails (retryable, not cached-empty)", async () => {
    const failing = indexerOf(async () => {
      throw new Error("indexer down");
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [failing] }));
    expect(result.outage).toBe(true);
    expect(result.streams).toEqual([]);
  });

  it("reports an outage when the debrid key is rejected", async () => {
    const provider = providerOf({
      checkCache: async () => {
        throw new DebridError("auth failed", true);
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ provider }));
    expect(result.outage).toBe(true);
  });

  it("is a plain no-match (not an outage) when indexers return nothing", async () => {
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([])] }));
    expect(result.outage).toBe(false);
    expect(result.streams).toEqual([]);
  });

  it("skips a torrent that isn't cached (uncached can never resolve now)", async () => {
    const provider = providerOf({ cache: { cached: false, files: albumFiles } });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ provider }));
    expect(result.streams).toEqual([]);
    expect(result.outage).toBe(false);
  });

  it("reports an outage when EVERY candidate fails on a provider error (A-011)", async () => {
    // A total debrid outage used to be swallowed into an empty success and then
    // cached for 300s, so users saw "no source has this track" during a
    // provider outage and recovery was delayed.
    const provider = providerOf({
      checkCache: async () => {
        throw new DebridError("503 service unavailable", false); // transient, NOT auth
      },
    });
    const many = [candidate, { ...candidate, infoHash: "cccccccccccccccccccccccccccccccccccccccc" }];
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf(many)], provider }));
    expect(result.outage).toBe(true);
    expect(result.streams).toEqual([]);
  });

  it("does NOT report an outage when candidates legitimately have nothing", async () => {
    // Uncached / no matching file are real negative answers from a healthy
    // provider — they must stay a cacheable no-match, not a retryable error.
    const provider = providerOf({ cache: { cached: false } });
    const many = [candidate, { ...candidate, infoHash: "dddddddddddddddddddddddddddddddddddddddd" }];
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf(many)], provider }));
    expect(result.outage).toBe(false);
    expect(result.streams).toEqual([]);
  });

  it("does NOT report an outage when some candidates fail but one succeeds", async () => {
    const good = { ...candidate, infoHash: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" };
    const provider = providerOf({
      checkCache: async (ref) => {
        if (ref.infoHash !== good.infoHash) throw new DebridError("boom", false);
        return { cached: true, files: albumFiles };
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([candidate, good])], provider }));
    expect(result.outage).toBe(false);
    expect(result.streams).toHaveLength(1);
  });

  it("isolates a single failing torrent without sinking the whole response", async () => {
    const good = { ...candidate, infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const bad = { ...candidate, infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    const provider = providerOf({
      checkCache: async (ref) => {
        if (ref.infoHash === bad.infoHash) throw new DebridError("torrent gone", false); // transient, not auth
        return { cached: true, files: albumFiles };
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([bad, good])], provider }));
    expect(result.outage).toBe(false);
    expect(result.streams).toHaveLength(1);
  });

  it("caps how many *uncached* torrents it will add to the account", async () => {
    // Nothing is on the account, so every probe is an expensive add. Real-Debrid
    // allows 250 requests/minute and the player prefetches ahead — an unbounded
    // fan-out here is a self-inflicted rate limit.
    const many = Array.from({ length: 10 }, (_, i) => ({ ...candidate, infoHash: String(i).repeat(40) }));
    const probed: string[] = [];
    const provider = providerOf({
      checkCache: async (ref) => (probed.push(ref.infoHash), { cached: false }),
    });
    await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf(many)], provider }));
    expect(probed).toHaveLength(3);
  });

  it("stops spending adds on uncached candidates once a cached stream is found", async () => {
    // The account already holds one match; the others are uncached. Add-checking
    // them anyway (to fill out the stream list) burned RD's rate limit → 429s.
    const cached = { ...candidate, infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const uncached = { ...candidate, infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", seeders: 9999 };
    const added: string[] = [];
    const provider = providerOf({
      listCached: async () => new Map([[cached.infoHash, "T-CACHED"]]),
      checkCache: async (ref) => {
        if (ref.handle) return { cached: true, files: albumFiles, handle: ref.handle };
        added.push(ref.infoHash); // reached only if we spend an add on an uncached candidate
        return { cached: false };
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([uncached, cached])], provider }));
    expect(result.streams).toHaveLength(1);
    expect(added).toEqual([]); // never added the uncached candidate once the cached one gave a stream
  });

  it("does not report an outage merely because the add budget ran out", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...candidate, infoHash: String(i).repeat(40) }));
    const provider = providerOf({ cache: { cached: false } });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf(many)], provider }));
    expect(result.outage).toBe(false);
    expect(result.streams).toEqual([]);
  });

  it("returns nothing when metadata can't resolve the recording", async () => {
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ metadata: metadataOf(undefined) }));
    expect(result.streams).toEqual([]);
    expect(result.outage).toBe(false);
  });
});

describe("resolveStreams — ranking and caps", () => {
  it("honors maxResults", async () => {
    const many = Array.from({ length: 5 }, (_v, i) => ({
      ...candidate,
      infoHash: String(i).repeat(40).slice(0, 40),
    }));
    const result = await resolveStreams({ recordingId: RID }, config({ maxResults: 2 }), deps({ indexers: [indexerOf(many)] }));
    expect(result.streams.length).toBeLessThanOrEqual(2);
  });

  it("dedupes the same infohash found on multiple indexers", async () => {
    const a = indexerOf([{ ...candidate, seeders: 10 }]);
    const b = indexerOf([{ ...candidate, seeders: 99 }]);
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [a, b] }));
    expect(result.streams).toHaveLength(1); // one hash → one stream
  });
});

describe("rankCandidates — album relevance dominates seeders/format", () => {
  const cfg = config();
  const c = (title: string, seeders: number, format = "FLAC"): TorrentCandidate => ({
    indexer: "fake",
    title,
    infoHash: HASH,
    seeders,
    format,
  });

  it("self-titled album: the year picks the right release over a better-seeded namesake", () => {
    // "Taylor Swift" by Taylor Swift → query "Taylor Swift Taylor Swift" matches
    // every release by her; only the year separates the 2006 debut from 1989.
    const selfTitled: TrackContext = {
      artist: "Taylor Swift",
      album: "Taylor Swift",
      year: 2006,
      title: "Tim McGraw",
      disc: 1,
      position: "1",
      hasAlbumContext: true,
    };
    const ranked = rankCandidates(
      [
        c("Taylor Swift - 1989 (2014) [FLAC]", 5000), // far more seeded, wrong album
        c("Taylor Swift - Taylor Swift (2006) [FLAC]", 20), // the debut
      ],
      selfTitled,
      cfg,
    );
    expect(ranked[0]!.title).toContain("2006");
  });

  it("demotes a discography pack below the genuine single album", () => {
    const selfTitled: TrackContext = {
      artist: "Taylor Swift",
      album: "Taylor Swift",
      year: 2006,
      title: "Tim McGraw",
      disc: 1,
      position: "1",
      hasAlbumContext: true,
    };
    const ranked = rankCandidates(
      [
        c("Taylor Swift - Discography (2006-2022) [FLAC]", 9000), // spans 2006, hugely seeded
        c("Taylor Swift - Taylor Swift (2006) [FLAC]", 15),
      ],
      selfTitled,
      cfg,
    );
    expect(ranked[0]!.title).toContain("Taylor Swift (2006)");
  });

  it("normal album: a title matching the album beats a better-seeded other album", () => {
    const ranked = rankCandidates(
      [c("Daft Punk - Random Access Memories [FLAC]", 8000), c("Daft Punk - Discovery [FLAC]", 30)],
      track, // album "Discovery"
      cfg,
    );
    expect(ranked[0]!.title).toContain("Discovery");
  });

  it("bare recording (no album context): falls back to seeders/format, no regression", () => {
    const bare: TrackContext = { artist: "Daft Punk", title: "Digital Love", hasAlbumContext: false };
    const ranked = rankCandidates([c("some torrent", 10), c("another torrent", 9000)], bare, cfg);
    expect(ranked[0]!.seeders).toBe(9000);
  });
});

describe("keepRelevantCandidates — gate out different albums", () => {
  const c = (title: string, seeders: number): TorrentCandidate => ({ indexer: "fake", title, infoHash: HASH, seeders });
  const selfTitled: TrackContext = {
    artist: "Taylor Swift",
    album: "Taylor Swift",
    year: 2006,
    title: "Tim McGraw",
    disc: 1,
    position: "1",
    hasAlbumContext: true,
  };

  it("drops a wrong-album torrent even when it's far better seeded (the willow bug)", () => {
    const kept = keepRelevantCandidates(
      [c("Taylor Swift - evermore (2020) [FLAC]", 9000), c("Taylor Swift - Taylor Swift (2006) [FLAC]", 10)],
      selfTitled,
    );
    expect(kept.map((k) => k.title)).toEqual(["Taylor Swift - Taylor Swift (2006) [FLAC]"]);
  });

  it("keeps all when no year separates them (nothing safe to gate on)", () => {
    // No candidate title carries a year → every one only matches the artist name.
    const cands = [c("Taylor Swift - Taylor Swift [FLAC]", 10), c("Taylor Swift - evermore [FLAC]", 9000)];
    expect(keepRelevantCandidates(cands, selfTitled)).toHaveLength(2);
  });

  it("keeps same-album variants (deluxe/format) of the requested album", () => {
    const kept = keepRelevantCandidates(
      [c("Taylor Swift - Taylor Swift (2006) [FLAC]", 10), c("Taylor Swift - Taylor Swift (2006) Deluxe [MP3]", 5)],
      selfTitled,
    );
    expect(kept).toHaveLength(2);
  });

  it("is a no-op for a bare recording (no album context)", () => {
    const bare: TrackContext = { artist: "x", title: "y", hasAlbumContext: false };
    const cands = [c("whatever", 1), c("another", 2)];
    expect(keepRelevantCandidates(cands, bare)).toHaveLength(2);
  });
});

describe("keepRelevantCandidates — multi-year collections are dropped", () => {
  const c = (title: string, seeders: number): TorrentCandidate => ({ indexer: "fake", title, infoHash: HASH, seeders });
  const selfTitled: TrackContext = {
    artist: "Taylor Swift",
    album: "Taylor Swift",
    year: 2006,
    title: "The Outside",
    disc: 1,
    position: "6",
    hasAlbumContext: true,
  };

  it("drops a hits comp whose year-range spans the album year, over the real album", () => {
    // "40 Biggest Hot 100 Hits 2006-2021" matched artist + a year from its range,
    // scoring like the debut and ranking above it on seeders — its track 6 is a
    // different song. The year *range* marks it as a multi-album pack.
    const kept = keepRelevantCandidates(
      [
        c("Taylor Swift - 40 Biggest Hot 100 Hits 2006-2021 [FLAC]", 40),
        c("Taylor Swift - Taylor Swift (2006) [FLAC]", 1),
      ],
      selfTitled,
    );
    expect(kept.map((k) => k.title)).toEqual(["Taylor Swift - Taylor Swift (2006) [FLAC]"]);
  });

  it("does not treat a normal album+year title ('1989 (2014)') as a collection", () => {
    const target: TrackContext = { artist: "Taylor Swift", album: "1989", year: 2014, title: "Style", disc: 1, position: "3", hasAlbumContext: true };
    const kept = keepRelevantCandidates([c("Taylor Swift - 1989 (2014) [FLAC]", 100)], target);
    expect(kept).toHaveLength(1); // kept, not penalized as a year-range
  });
});

describe("resolveStreams — download uncached (resolving)", () => {
  const withDownload = (startDownload: NonNullable<DebridProvider["startDownload"]>): DebridProvider =>
    providerOf({ listCached: async () => new Map(), checkCache: async () => ({ cached: false }), startDownload });
  const seeded = (seeders: number) => deps({ indexers: [indexerOf([{ ...candidate, seeders }])] });

  it("starts a download and returns a resolving marker when nothing is cached", async () => {
    const provider = withDownload(async () => ({ handle: "T1", done: false, progress: 0.3 }));
    const result = await resolveStreams({ recordingId: RID }, config(), { ...seeded(10), provider });
    expect(result.streams).toEqual([]);
    expect(result.resolving).toMatchObject({ progress: 0.3 });
    expect(result.resolving?.message).toBeTruthy();
  });

  it("resolves a real stream when the download has just completed", async () => {
    const provider = providerOf({
      listCached: async () => new Map(),
      // probe (no handle) = uncached; completion path re-checks by handle = cached.
      checkCache: async (ref) => (ref.handle ? { cached: true, files: albumFiles, handle: ref.handle } : { cached: false }),
      startDownload: async () => ({ handle: "T1", done: true, files: albumFiles }),
    });
    const result = await resolveStreams({ recordingId: RID }, config(), { ...seeded(10), provider });
    expect(result.streams).toHaveLength(1);
    expect(result.resolving).toBeUndefined();
  });

  it("does not download when the feature is off", async () => {
    const started = vi.fn(async () => ({ handle: "T1", done: false }));
    const result = await resolveStreams({ recordingId: RID }, config({ downloadUncached: false }), {
      ...seeded(10),
      provider: withDownload(started),
    });
    expect(result.resolving).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
  });

  it("does not download a candidate below the seeders floor", async () => {
    const started = vi.fn(async () => ({ handle: "T1", done: false }));
    const result = await resolveStreams({ recordingId: RID }, config({ downloadSeedersFloor: 5 }), {
      ...seeded(1),
      provider: withDownload(started),
    });
    expect(result.resolving).toBeUndefined();
    expect(started).not.toHaveBeenCalled();
  });

  it("treats a dead torrent as a no-match, not resolving", async () => {
    const provider = withDownload(async () => ({ handle: "T1", done: false, dead: true }));
    const result = await resolveStreams({ recordingId: RID }, config(), { ...seeded(10), provider });
    expect(result.resolving).toBeUndefined();
    expect(result.streams).toEqual([]);
  });

  it("reports an outage when starting the download hits a bad key", async () => {
    const provider = withDownload(async () => {
      throw new DebridError("auth failed", true);
    });
    const result = await resolveStreams({ recordingId: RID }, config(), { ...seeded(10), provider });
    expect(result.outage).toBe(true);
  });
});
