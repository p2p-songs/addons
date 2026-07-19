import { describe, it, expect } from "vitest";
import { createRouter, manifestSchema } from "@p2p-songs/addon-sdk";
import { createMusicMetaAddon } from "../src/handler.js";
import { manifest } from "../src/manifest.js";
import { FakeMusicBrainz, UUID } from "./fakes.js";

const enc = encodeURIComponent;

describe("musicmeta manifest", () => {
  it("is a valid addon manifest with search catalogs", () => {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest.catalogs.map((c) => c.type).sort()).toEqual(["album", "artist", "track"]);
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
