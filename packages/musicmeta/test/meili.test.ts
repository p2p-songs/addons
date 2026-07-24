import { afterEach, describe, expect, it, vi } from "vitest";
import { MeiliSearchIndex } from "../src/meili.js";

const REC = "mbid:recording:11111111-1111-4111-8111-111111111111";
const REL = "mbid:release:22222222-2222-4222-8222-222222222222";

type Reply = { status: number; json: unknown };
type Handler = (method: string, path: string, body: unknown) => Reply;

/** Stub global fetch with a path-routed handler; returns the call log. */
function install(handler: Handler): { method: string; path: string; body: unknown }[] {
  const calls: { method: string; path: string; body: unknown }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      calls.push({ method, path, body });
      const { status, json } = handler(method, path, body);
      return new Response(JSON.stringify(json), { status, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("MeiliSearchIndex (read-only)", () => {
  it("maps search hits to previews, filtering by type — no index creation", async () => {
    const calls = install((m, p) => {
      if (m === "POST" && p === "/indexes/catalog/search") {
        return { status: 200, json: { hits: [{ docId: "x", id: REC, type: "track", name: "Baby" }] } };
      }
      return { status: 500, json: {} };
    });
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    const out = await index.search("track", "baby", 10);

    expect(out).toEqual([{ type: "track", id: REC, name: "Baby" }]);
    // It only ever searches — never POST /indexes, PATCH /settings, PUT documents.
    expect(calls.every((c) => c.path === "/indexes/catalog/search")).toBe(true);
    // The type filter is passed through.
    expect(calls[0]!.body).toMatchObject({ filter: 'type = "track"' });
  });

  it("synthesizes a Cover Art Archive poster for album hits", async () => {
    install(() => ({ status: 200, json: { hits: [{ docId: "y", id: REL, type: "album", name: "My World 2.0" }] } }));
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    const out = await index.search("album", "my world", 10);

    expect(out[0]!.poster).toContain("coverartarchive.org/release/22222222-2222-4222-8222-222222222222/front");
  });

  it("returns [] when the index does not exist yet (404), rather than throwing", async () => {
    install(() => ({ status: 404, json: { message: "Index `catalog` not found." } }));
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    await expect(index.search("track", "baby", 10)).resolves.toEqual([]);
  });

  it("propagates a genuine failure (not a 404)", async () => {
    install(() => ({ status: 500, json: { message: "boom" } }));
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    await expect(index.search("track", "baby", 10)).rejects.toThrow();
  });

  it("stats reads the type facet distribution", async () => {
    const calls = install((_m, p) => {
      if (p === "/indexes/catalog/search") {
        return { status: 200, json: { facetDistribution: { type: { artist: 12599, album: 2120, track: 20000 } } } };
      }
      return { status: 500, json: {} };
    });
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    const stats = await index.stats();

    expect(stats).toEqual({ artist: 12599, album: 2120, track: 20000, total: 34719 });
    expect(calls[0]!.body).toMatchObject({ limit: 0, facets: ["type"] });
  });

  it("stats returns zeros when the index does not exist yet", async () => {
    install(() => ({ status: 404, json: { message: "Index `catalog` not found." } }));
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    await expect(index.stats()).resolves.toEqual({ artist: 0, album: 0, track: 0, total: 0 });
  });
});
