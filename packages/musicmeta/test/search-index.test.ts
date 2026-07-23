/**
 * The search index sits in front of MusicBrainz as a read-through / write-back
 * cache. The behaviours that matter — and that are invisible to the typechecker
 * — are: a warm query is answered from the index without touching MusicBrainz; a
 * cold query falls through to MusicBrainz *and hydrates the index*; and the
 * index is an accelerator, not a dependency, so a broken one never breaks (or
 * even slows) search. Each is asserted here against fakes, no network.
 */
import { describe, it, expect } from "vitest";
import { metaPreviewSchema, type MetaPreview } from "@p2p-songs/addon-sdk";
import { searchCatalog, DEFAULT_MIN_INDEX_HITS } from "../src/catalog.js";
import { FakeSearchIndex, type SearchIndex } from "../src/search-index.js";
import { FakeMusicBrainz, UUID } from "./fakes.js";

/** A MusicBrainz fake that counts how many times track search was consulted. */
class CountingMb extends FakeMusicBrainz {
  searchRecordingsCalls = 0;
  override async searchRecordings(): Promise<Awaited<ReturnType<FakeMusicBrainz["searchRecordings"]>>> {
    this.searchRecordingsCalls++;
    return super.searchRecordings();
  }
}

/** Distinct, schema-valid MBID uuids without leaning on the fixtures' fixed set. */
function uuid(i: number): string {
  const h = (i & 0xff).toString(16).padStart(2, "0");
  return `${h}${h}${h}${h}-${h}${h}-${h}${h}-${h}${h}-${h}${h}${h}${h}${h}${h}`;
}

/** `n` distinct track previews, enough to clear (or miss) the warm-hit floor. */
function bandOfTracks(n: number): MetaPreview[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "track" as const,
    id: `mbid:recording:${uuid(i)}`,
    name: `Vampire ${i}`,
    description: "Olivia Rodrigo",
  }));
}

describe("searchCatalog with a SearchIndex", () => {
  it("with no index configured, behaves as a plain MusicBrainz search", async () => {
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });
    const metas = await searchCatalog("track", "vampire", { mb });
    expect(metas[0]!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(mb.searchRecordingsCalls).toBe(1);
  });

  it("a cold query falls through to MusicBrainz and hydrates the index", async () => {
    const index = new FakeSearchIndex();
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });

    const metas = await searchCatalog("track", "vampire", { mb, index });

    expect(metas[0]!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(mb.searchRecordingsCalls).toBe(1); // cold → MB was consulted
    // Hydration is fire-and-forget; let the microtask settle, then assert it landed.
    await Promise.resolve();
    expect(index.size).toBeGreaterThan(0);
  });

  it("a warm query is served from the index without touching MusicBrainz", async () => {
    const index = new FakeSearchIndex();
    await index.upsert(bandOfTracks(DEFAULT_MIN_INDEX_HITS));
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "unreachable", artist: "x" }] });

    const metas = await searchCatalog("track", "vampire", { mb, index });

    expect(metas.length).toBeGreaterThanOrEqual(DEFAULT_MIN_INDEX_HITS);
    expect(mb.searchRecordingsCalls).toBe(0); // warm → MB never consulted
    expect(metaPreviewSchema.safeParse(metas[0]).success).toBe(true);
  });

  it("a thin index (below the floor) is treated as cold and defers to MusicBrainz", async () => {
    const index = new FakeSearchIndex();
    await index.upsert(bandOfTracks(DEFAULT_MIN_INDEX_HITS - 1)); // one short of the floor
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });

    await searchCatalog("track", "vampire", { mb, index });

    expect(mb.searchRecordingsCalls).toBe(1); // MB answered the fuller result
  });

  it("an unreachable index never breaks search — it falls through to MusicBrainz", async () => {
    const broken: SearchIndex = {
      search: () => Promise.reject(new Error("meili down")),
      upsert: () => Promise.reject(new Error("meili down")),
    };
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });

    // A rejecting upsert must not surface as an unhandled rejection either.
    const metas = await searchCatalog("track", "vampire", { mb, index: broken });

    expect(metas[0]!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(mb.searchRecordingsCalls).toBe(1);
  });
});

describe("FakeSearchIndex", () => {
  it("returns only documents of the requested type", async () => {
    const index = new FakeSearchIndex();
    await index.upsert([
      { type: "artist", id: `mbid:artist:${UUID.artist}`, name: "Olivia Rodrigo" },
      ...bandOfTracks(3),
    ]);

    const artists = await index.search("artist", "olivia", 10);
    const tracks = await index.search("track", "vampire", 10);

    expect(artists.map((m) => m.type)).toEqual(["artist"]);
    expect(tracks.every((m) => m.type === "track")).toBe(true);
    expect(tracks.length).toBe(3);
  });

  it("upsert is idempotent by id", async () => {
    const index = new FakeSearchIndex();
    await index.upsert(bandOfTracks(2));
    await index.upsert(bandOfTracks(2)); // same ids again
    expect(index.size).toBe(2);
  });
});
