import { describe, it, expect } from "vitest";
import { metaPreviewSchema } from "@p2p-songs/addon-sdk";
import { searchCatalog } from "../src/catalog.js";
import { FakeMusicBrainz, UUID } from "./fakes.js";

describe("searchCatalog emits correct entity-typed ids per content type", () => {
  it("artist search → mbid:artist ids", async () => {
    const mb = new FakeMusicBrainz({ artists: [{ id: UUID.artist, name: "Aphex Twin" }] });
    const metas = await searchCatalog("artist", "aphex", { mb });
    expect(metas[0]!.id).toBe(`mbid:artist:${UUID.artist}`);
    expect(metas[0]!.type).toBe("artist");
    expect(metaPreviewSchema.safeParse(metas[0]).success).toBe(true);
  });

  it("album search → mbid:release ids with a cover-art poster", async () => {
    const mb = new FakeMusicBrainz({ releases: [{ id: UUID.release, title: "SAW", artist: "Aphex Twin" }] });
    const metas = await searchCatalog("album", "saw", { mb });
    expect(metas[0]!.id).toBe(`mbid:release:${UUID.release}`);
    expect(metas[0]!.poster).toContain(`coverartarchive.org/release/${UUID.release}/front`);
    expect(metaPreviewSchema.safeParse(metas[0]).success).toBe(true);
  });

  it("track search → mbid:recording ids (the streamable identity)", async () => {
    const mb = new FakeMusicBrainz({ recordings: [{ id: UUID.rec1, title: "Xtal", artist: "Aphex Twin" }] });
    const metas = await searchCatalog("track", "xtal", { mb });
    expect(metas[0]!.id).toBe(`mbid:recording:${UUID.rec1}`);
    expect(metaPreviewSchema.safeParse(metas[0]).success).toBe(true);
  });

  it("a type/id mismatch would be rejected by the schema (guards honesty)", () => {
    // An album preview carrying a recording id must not validate.
    const bad = { type: "album", id: `mbid:recording:${UUID.rec1}`, name: "x" };
    expect(metaPreviewSchema.safeParse(bad).success).toBe(false);
  });
});
