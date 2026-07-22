import { describe, it, expect } from "vitest";
import { resolveStreams } from "../src/resolve.js";
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
