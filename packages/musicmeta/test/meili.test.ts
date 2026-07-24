import { afterEach, describe, expect, it, vi } from "vitest";
import { MeiliSearchIndex } from "../src/meili.js";

const REC = "mbid:recording:11111111-1111-4111-8111-111111111111";
const trackHit = { docId: "x", id: REC, type: "track", name: "Baby" };

type Reply = { status: number; json: unknown };
type Handler = (method: string, path: string, body: unknown) => Reply;

/** Stub global fetch with a path-routed handler; returns the call log. */
function install(handler: Handler): { method: string; path: string }[] {
  const calls: { method: string; path: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const path = new URL(url).pathname;
      calls.push({ method, path });
      const body = init?.body ? JSON.parse(init.body as string) : undefined;
      const { status, json } = handler(method, path, body);
      return new Response(JSON.stringify(json), {
        status,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return calls;
}

/** The happy-path replies for index creation + settings. */
function ready(method: string, path: string): Reply | undefined {
  if (method === "POST" && path === "/indexes") return { status: 202, json: { taskUid: 0 } };
  if (method === "PATCH" && path.endsWith("/settings")) return { status: 202, json: { taskUid: 1 } };
  if (method === "GET" && path.startsWith("/tasks/")) return { status: 200, json: { status: "succeeded" } };
  return undefined;
}

afterEach(() => vi.unstubAllGlobals());

describe("MeiliSearchIndex", () => {
  it("initializes then maps search hits to previews", async () => {
    install((m, p) => ready(m, p) ?? { status: 200, json: { hits: [trackHit] } });
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    const out = await index.search("track", "baby", 10);

    expect(out).toEqual([{ type: "track", id: REC, name: "Baby" }]);
  });

  it("re-creates the index and retries when a search finds it missing", async () => {
    let searches = 0;
    const calls = install((m, p) => {
      const r = ready(m, p);
      if (r) return r;
      // First search 404s (index wiped under us); the retry succeeds.
      return searches++ === 0
        ? { status: 404, json: { message: "Index `catalog` not found." } }
        : { status: 200, json: { hits: [trackHit] } };
    });
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    const out = await index.search("track", "baby", 10);

    expect(out).toEqual([{ type: "track", id: REC, name: "Baby" }]);
    // The index was created twice: initial setup, then again after the 404.
    expect(calls.filter((c) => c.method === "POST" && c.path === "/indexes")).toHaveLength(2);
  });

  it("retries initialization after a transient failure instead of caching it", async () => {
    let indexCreateAttempts = 0;
    install((m, p) => {
      if (m === "POST" && p === "/indexes") {
        // Fail the very first create; succeed thereafter.
        return indexCreateAttempts++ === 0
          ? { status: 502, json: { message: "bad gateway" } }
          : { status: 202, json: { taskUid: 0 } };
      }
      return ready(m, p) ?? { status: 200, json: { hits: [trackHit] } };
    });
    const index = new MeiliSearchIndex({ url: "http://meili:7700" });

    await expect(index.search("track", "baby", 10)).rejects.toThrow();
    // The failure did not poison the memo: a later call initializes and succeeds.
    const out = await index.search("track", "baby", 10);
    expect(out).toEqual([{ type: "track", id: REC, name: "Baby" }]);
  });
});
