import { describe, it, expect } from "vitest";
import { createRouter, manifestSchema } from "@p2p-songs/addon-sdk";
import { createMusicMetaAddon } from "../src/handler.js";
import { manifest } from "../src/manifest.js";
import { FakeMusicBrainz, UUID } from "./fakes.js";

const enc = encodeURIComponent;

describe("musicmeta manifest", () => {
  it("is a valid addon manifest with search catalogs", () => {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    // type alone can't identify a catalog — album has both a search and a
    // discography one — so assert the pair the router actually dispatches on.
    expect(manifest.catalogs.map((c) => `${c.type}/${c.id}`).sort()).toEqual([
      "album/byArtist",
      "album/search",
      "artist/search",
      "track/search",
    ]);
  });

  it("declares every search catalog as requiring `search`, and discography `artistId`", () => {
    for (const cat of manifest.catalogs) {
      const required = (cat.extra ?? []).filter((e) => e.isRequired).map((e) => e.name);
      expect(required).toEqual(cat.id === "byArtist" ? ["artistId"] : ["search"]);
    }
  });
});

describe("musicmeta over the SDK router", () => {
  const mb = new FakeMusicBrainz({
    recordings: [{ id: UUID.rec1, title: "Xtal", artist: "Aphex Twin" }],
    recording: { [UUID.rec1]: { id: UUID.rec1, title: "Xtal", artist: "Aphex Twin", durationMs: 293000 } },
  });
  const route = createRouter(createMusicMetaAddon({ mb }));

  it("serves a search catalog", async () => {
    const extra = enc("search=xtal");
    const r = await route({ method: "GET", url: `/catalog/track/search/${extra}.json` });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.metas[0].id).toBe(`mbid:recording:${UUID.rec1}`);
  });

  it("empty search returns an empty catalog (not an error)", async () => {
    const r = await route({ method: "GET", url: `/catalog/track/search.json` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).metas).toEqual([]);
  });

  it("serves meta for a recording id", async () => {
    const r = await route({ method: "GET", url: `/meta/track/${enc(`mbid:recording:${UUID.rec1}`)}.json` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).meta.name).toBe("Xtal");
  });

  it("inherits the SDK boundary: a bad content type is 404", async () => {
    const r = await route({ method: "GET", url: `/catalog/widget/search/${enc("search=x")}.json` });
    expect(r.status).toBe(404);
  });
});

describe("discography catalog", () => {
  const UU = { artist: "11111111-1111-1111-1111-111111111111", rel1: "22222222-2222-2222-2222-222222222222", rel2: "33333333-3333-3333-3333-333333333333" };
  const mb = new FakeMusicBrainz({
    artistReleases: [
      { id: UU.rel1, title: "Selected Ambient Works 85\u201392", artist: "Aphex Twin", date: "1992-11-09" },
      { id: UU.rel2, title: "Drukqs", artist: "Aphex Twin", date: "2001-10-22" },
    ],
  });
  const route = createRouter(createMusicMetaAddon({ mb }));
  const call = (extra: string) => route({ method: "GET", url: `/catalog/album/byArtist/${enc(extra)}.json` });

  it("turns an artist id into album previews the album screen already understands", async () => {
    const r = await call(`artistId=mbid:artist:${UU.artist}`);
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.metas).toHaveLength(2);
    // `mbid:release:` — the same id shape album *search* emits, so nothing
    // downstream needs a special case for a discography result.
    expect(body.metas.every((m: { id: string; type: string }) => m.type === "album" && m.id.startsWith("mbid:release:"))).toBe(true);
    expect(body.metas[0].name).toBe("Selected Ambient Works 85\u201392");
    expect(body.metas[0].description).toBe("1992"); // year, not artist — every row shares the artist
  });

  it("returns empty rather than erroring when the required artistId is absent", async () => {
    const r = await call("search=aphex");
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).metas).toEqual([]);
  });
});
