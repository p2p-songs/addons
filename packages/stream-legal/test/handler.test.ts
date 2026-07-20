import { describe, it, expect } from "vitest";
import { createRouter, manifestSchema } from "@p2p-songs/addon-sdk";
import { createStreamLegalAddon } from "../src/handler.js";
import { manifest } from "../src/manifest.js";
import type { MetadataLookup } from "../src/metadata.js";
import type { Candidate, LegalSource } from "../src/sources/types.js";

const REC = "mbid:recording:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const enc = encodeURIComponent;

const meta: MetadataLookup = { lookup: async () => ({ artist: "Kevin MacLeod", title: "Cipher", durationMs: 120000 }) };
const candidate: Candidate = {
  source: "internet-archive",
  title: "Cipher",
  artist: "Kevin MacLeod",
  url: "https://archive.org/download/x/cipher.mp3",
  format: "MP3",
  durationMs: 120000,
  license: "https://creativecommons.org/licenses/by/3.0/",
};
const source: LegalSource = { id: "internet-archive", name: "IA", search: async () => [candidate] };
const deadSource: LegalSource = { id: "dead", name: "dead", search: async () => { throw new Error("outage"); } };

describe("stream-legal manifest", () => {
  it("is a valid addon manifest", () => {
    expect(manifestSchema.safeParse(manifest).success).toBe(true);
  });
});

describe("stream-legal over the SDK router", () => {
  const addon = createStreamLegalAddon({ metadata: meta, sources: [source] });
  const route = createRouter(addon);

  it("serves a resolved https stream for a recording id", async () => {
    const r = await route({ method: "GET", url: `/stream/track/${enc(REC)}.json` });
    expect(r.status).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.streams[0].url).toBe("https://archive.org/download/x/cipher.mp3");
    expect(r.headers["Cache-Control"]).toContain("max-age=");
  });

  it("inherits the SDK boundary: a non-track type is rejected", async () => {
    const r = await route({ method: "GET", url: `/stream/artist/${enc(REC)}.json` });
    expect(r.status).toBe(404);
  });

  it("genuine no-match → empty 200 with only a SHORT cache (A-006)", async () => {
    const empty = createStreamLegalAddon({ metadata: { lookup: async () => undefined }, sources: [source] });
    const r = await createRouter(empty)({ method: "GET", url: `/stream/track/${enc(REC)}.json` });
    expect(r.status).toBe(200);
    expect(JSON.parse(r.body).streams).toEqual([]);
    expect(r.headers["Cache-Control"]).toContain("max-age=300");
  });

  it("total source outage → uncacheable error, NOT a cached empty 200 (A-006)", async () => {
    const down = createStreamLegalAddon({ metadata: meta, sources: [deadSource] });
    const r = await createRouter(down)({ method: "GET", url: `/stream/track/${enc(REC)}.json` });
    expect(r.status).toBe(500);
    // 500 is not heuristically cacheable, so a transient outage can't poison caches.
    expect(r.headers["Cache-Control"]).toBeUndefined();
  });
});
