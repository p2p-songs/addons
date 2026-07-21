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

  it("skips a torrent that isn't cached in cachedOnly mode", async () => {
    const provider = providerOf({ cache: { cached: false, files: albumFiles } });
    const result = await resolveStreams({ recordingId: RID }, config({ cachedOnly: true }), deps({ provider }));
    expect(result.streams).toEqual([]);
    expect(result.outage).toBe(false);
  });

  it("isolates a single failing torrent without sinking the whole response", async () => {
    const good = { ...candidate, infoHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" };
    const bad = { ...candidate, infoHash: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" };
    const provider = providerOf({
      checkCache: async (hash) => {
        if (hash === bad.infoHash) throw new DebridError("torrent gone", false); // transient, not auth
        return { cached: true, files: albumFiles };
      },
    });
    const result = await resolveStreams({ recordingId: RID }, config(), deps({ indexers: [indexerOf([bad, good])], provider }));
    expect(result.outage).toBe(false);
    expect(result.streams).toHaveLength(1);
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
