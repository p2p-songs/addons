import { describe, it, expect } from "vitest";
import { CachedMusicBrainz } from "../src/index.js";
import type { MusicBrainzClient, MbReleaseDetail } from "../src/index.js";

const REL = "22222222-2222-2222-2222-222222222222";

/** A client that counts calls and can be made to hang until released. */
function countingClient(overrides: Partial<MusicBrainzClient> = {}) {
  const calls: string[] = [];
  const detail = { id: REL, title: "Album", artist: "Artist", tracks: [] } as MbReleaseDetail;
  const client = {
    async searchArtists() { calls.push("searchArtists"); return []; },
    async searchReleases() { calls.push("searchReleases"); return []; },
    async searchRecordings() { calls.push("searchRecordings"); return []; },
    async artistDiscography() { calls.push("artistDiscography"); return []; },
    async getArtist() { calls.push("getArtist"); return undefined; },
    async getRelease() { calls.push("getRelease"); return detail; },
    async getRecording() { calls.push("getRecording"); return undefined; },
    ...overrides,
  } as MusicBrainzClient;
  return { client, calls };
}

describe("CachedMusicBrainz", () => {
  it("collapses an album's repeated release lookups into one request", async () => {
    // The reason this exists: playback resolves one track at a time, so a
    // 12-track album makes 12 identical getRelease calls — 12s of the client's
    // 1 req/sec budget spent re-fetching the same document.
    const { client, calls } = countingClient();
    const mb = new CachedMusicBrainz(client);
    for (let i = 0; i < 12; i++) await mb.getRelease(REL);
    expect(calls.filter((c) => c === "getRelease")).toHaveLength(1);
  });

  it("single-flights concurrent lookups, because the player prefetches", async () => {
    let resolveInner!: (v: MbReleaseDetail) => void;
    const calls: string[] = [];
    const { client } = countingClient({
      async getRelease() {
        calls.push("getRelease");
        return new Promise<MbReleaseDetail>((r) => { resolveInner = r; });
      },
    });
    const mb = new CachedMusicBrainz(client);
    const all = Promise.all([mb.getRelease(REL), mb.getRelease(REL), mb.getRelease(REL)]);
    resolveInner({ id: REL, title: "Album", artist: "Artist", tracks: [] });
    const [a, b, c] = await all;
    expect(calls).toHaveLength(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("refetches once an entry expires", async () => {
    let clock = 0;
    const { client, calls } = countingClient();
    const mb = new CachedMusicBrainz(client, { ttlMs: 1000, now: () => clock });
    await mb.getRelease(REL);
    clock = 999;
    await mb.getRelease(REL);
    expect(calls.filter((c) => c === "getRelease")).toHaveLength(1);
    clock = 1001;
    await mb.getRelease(REL);
    expect(calls.filter((c) => c === "getRelease")).toHaveLength(2);
  });

  it("caches a 404 too, but expires it sooner than a hit", async () => {
    let clock = 0;
    const { client, calls } = countingClient();
    const mb = new CachedMusicBrainz(client, { ttlMs: 1000, missTtlMs: 100, now: () => clock });
    await mb.getRecording("x");
    await mb.getRecording("x");
    expect(calls.filter((c) => c === "getRecording")).toHaveLength(1);
    clock = 150; // past the miss TTL, well inside the hit TTL
    await mb.getRecording("x");
    expect(calls.filter((c) => c === "getRecording")).toHaveLength(2);
  });

  it("does not cache free-text searches", async () => {
    const { client, calls } = countingClient();
    const mb = new CachedMusicBrainz(client);
    await mb.searchReleases("q", 25);
    await mb.searchReleases("q", 25);
    expect(calls.filter((c) => c === "searchReleases")).toHaveLength(2);
  });

  it("evicts the oldest entry rather than growing without bound", async () => {
    const { client } = countingClient();
    const mb = new CachedMusicBrainz(client, { maxEntries: 2 });
    await mb.getRelease("a");
    await mb.getRelease("b");
    await mb.getRelease("c");
    expect(mb.size).toBe(2);
  });

  it("keys by entity so a release and a recording sharing a uuid never collide", async () => {
    const { client, calls } = countingClient();
    const mb = new CachedMusicBrainz(client);
    await mb.getRelease(REL);
    await mb.getRecording(REL);
    expect(calls).toEqual(["getRelease", "getRecording"]);
  });
});
