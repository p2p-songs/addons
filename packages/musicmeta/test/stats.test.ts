import { describe, it, expect } from "vitest";
import { createStatsRoute } from "../src/stats.js";
import { FakeSearchIndex } from "../src/search-index.js";
import type { SearchIndex } from "../src/search-index.js";

const REQ = { method: "GET", url: "/stats" };

describe("createStatsRoute", () => {
  it("returns 200 with the catalogue counts when an index is configured", async () => {
    const index = new FakeSearchIndex().seed([
      { type: "artist", id: "mbid:artist:aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", name: "A" },
      { type: "album", id: "mbid:release:bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", name: "B" },
      { type: "track", id: "mbid:recording:cccccccc-cccc-4ccc-8ccc-cccccccccccc", name: "C" },
    ]);

    const res = await createStatsRoute(index)(REQ);

    expect(res.status).toBe(200);
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
    expect(JSON.parse(res.body)).toEqual({ artist: 1, album: 1, track: 1, total: 3 });
  });

  it("returns 503 when no index is configured (dev / MEILI_URL-less run)", async () => {
    const res = await createStatsRoute(undefined)(REQ);
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body)).toHaveProperty("error");
  });

  it("returns 503 when the index is unreachable rather than throwing", async () => {
    const broken: SearchIndex = {
      search: () => Promise.reject(new Error("meili down")),
      stats: () => Promise.reject(new Error("meili down")),
    };
    const res = await createStatsRoute(broken)(REQ);
    expect(res.status).toBe(503);
  });
});
