/**
 * The search index is now the **curated store `musicmeta` serves search from**
 * (built offline, read-only from the addon's side). The behaviours that matter —
 * and are invisible to the typechecker — are: with an index configured, search is
 * served from it *only* and MusicBrainz is never consulted; without one, search
 * falls back to direct MusicBrainz (the dev path). Plus the `FakeSearchIndex`
 * search/stats semantics the other tests lean on. Asserted against fakes, no
 * network.
 */
import { describe, it, expect } from "vitest";
import { metaPreviewSchema, type MetaPreview } from "@p2p-songs/addon-sdk";
import { searchCatalog } from "../src/catalog.js";
import { FakeSearchIndex } from "../src/search-index.js";
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

/** `n` distinct track previews. */
function bandOfTracks(n: number): MetaPreview[] {
  return Array.from({ length: n }, (_, i) => ({
    type: "track" as const,
    id: `mbid:recording:${uuid(i)}`,
    name: `Vampire ${i}`,
    description: "Olivia Rodrigo",
  }));
}

describe("searchCatalog source selection", () => {
  it("with no index configured, falls back to a direct MusicBrainz search", async () => {
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });
    const metas = await searchCatalog("track", "vampire", { mb });
    expect(metas[0]!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(mb.searchRecordingsCalls).toBe(1);
  });

  it("with an index configured, serves from it ONLY — MusicBrainz is never consulted", async () => {
    const index = new FakeSearchIndex().seed(bandOfTracks(3));
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "unreachable", artist: "x" }] });

    const metas = await searchCatalog("track", "vampire", { mb, index });

    expect(metas.length).toBe(3);
    expect(mb.searchRecordingsCalls).toBe(0); // curated store is the sole source
    expect(metaPreviewSchema.safeParse(metas[0]).success).toBe(true);
  });

  it("with an index configured, an empty result does NOT fall back to MusicBrainz", async () => {
    const index = new FakeSearchIndex(); // nothing seeded
    const mb = new CountingMb({ recordings: [{ id: UUID.rec1, title: "Vampire", artist: "Olivia Rodrigo" }] });

    const metas = await searchCatalog("track", "vampire", { mb, index });

    expect(metas).toEqual([]); // no live-MB fallback — the whole point of the inversion
    expect(mb.searchRecordingsCalls).toBe(0);
  });
});

describe("FakeSearchIndex", () => {
  it("returns only documents of the requested type", async () => {
    const index = new FakeSearchIndex().seed([
      { type: "artist", id: `mbid:artist:${UUID.artist}`, name: "Olivia Rodrigo" },
      ...bandOfTracks(3),
    ]);

    const artists = await index.search("artist", "olivia", 10);
    const tracks = await index.search("track", "vampire", 10);

    expect(artists.map((m) => m.type)).toEqual(["artist"]);
    expect(tracks.every((m) => m.type === "track")).toBe(true);
    expect(tracks.length).toBe(3);
  });

  it("seed is idempotent by id", () => {
    const index = new FakeSearchIndex().seed(bandOfTracks(2)).seed(bandOfTracks(2));
    expect(index.size).toBe(2);
  });

  it("stats reports per-type counts and a total", async () => {
    const index = new FakeSearchIndex().seed([
      { type: "artist", id: `mbid:artist:${UUID.artist}`, name: "Olivia Rodrigo" },
      { type: "album", id: `mbid:release:${UUID.release}`, name: "GUTS" },
      ...bandOfTracks(4),
    ]);
    expect(await index.stats()).toEqual({ artist: 1, album: 1, track: 4, total: 6 });
  });
});
