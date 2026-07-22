import { describe, it, expect, vi } from "vitest";
import { RealDebridProvider } from "../src/debrid/realdebrid.js";
import { DebridError } from "../src/debrid/types.js";

const HASH = "0123456789abcdef0123456789abcdef01234567";

interface FakeOptions {
  /** Status the torrent settles on once files are selected. */
  settledStatus?: string;
  /** Statuses served before selection is possible, in order (default: straight to selection). */
  preSelectStatuses?: string[];
  files?: { id: number; path: string; bytes?: number }[];
  download?: string;
  authFails?: boolean;
  /** Body returned by every call, to exercise RD's in-band error envelope. */
  errorBody?: unknown;
  /** Torrents the account already holds, for `GET /torrents`. */
  accountList?: { id: string; hash: string; status: string }[];
  onAuth?: (key: string | null) => void;
}

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

/**
 * A fake Real-Debrid that models the *actual* state machine: a magnet lands in
 * `waiting_files_selection`, only selection moves it on, and `links` is derived
 * from what was selected. Getting this wrong is how the real bug hid.
 */
function fakeRd(opts: FakeOptions = {}) {
  const files = opts.files ?? [
    { id: 0, path: "/Album/01 - One.flac", bytes: 40_000_000 },
    { id: 1, path: "/Album/02 - Two.flac", bytes: 42_000_000 },
    { id: 2, path: "/Album/cover.jpg", bytes: 500_000 },
  ];
  const calls: { method: string; path: string; body?: string }[] = [];
  const torrents = new Map<string, { selected: Set<number>; status: string }>();
  let nextId = 1;
  const preSelect = [...(opts.preSelectStatuses ?? [])];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = init?.method ?? "GET";
    calls.push({ method, path, body: typeof init?.body === "string" ? init.body : undefined });
    opts.onAuth?.(new Headers(init?.headers).get("authorization"));
    if (opts.authFails) return new Response("denied", { status: 401 });
    if (opts.errorBody !== undefined) return json(opts.errorBody);

    if (path.includes("/torrents?")) return json(opts.accountList ?? []);

    if (path.endsWith("/torrents/addMagnet")) {
      const id = `T${nextId++}`;
      torrents.set(id, { selected: new Set(), status: "waiting_files_selection" });
      return json({ id });
    }

    if (path.includes("/torrents/selectFiles/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      const chosen = new URLSearchParams(init!.body as string).get("files")!;
      const t = torrents.get(id)!;
      for (const f of chosen.split(",")) t.selected.add(Number(f));
      t.status = opts.settledStatus ?? "downloaded";
      return new Response(null, { status: 204 });
    }

    if (path.includes("/torrents/delete/")) {
      torrents.delete(decodeURIComponent(path.split("/").pop()!));
      return new Response(null, { status: 204 });
    }

    if (path.includes("/torrents/info/")) {
      const id = decodeURIComponent(path.split("/").pop()!);
      const t = torrents.get(id) ?? { selected: new Set([0, 1, 2]), status: opts.settledStatus ?? "downloaded" };
      const status = t.status === "waiting_files_selection" && preSelect.length > 0 ? preSelect.shift()! : t.status;
      const selected = files.filter((f) => t.selected.has(f.id));
      return json({
        id,
        status,
        files: files.map((f) => ({ ...f, selected: t.selected.has(f.id) ? 1 : 0 })),
        // RD emits one link per *selected* file, in order.
        links: selected.map((f) => `https://rd.example/link-${f.id}`),
      });
    }

    if (path.endsWith("/unrestrict/link")) {
      return json({
        download: opts.download ?? "https://rd.example/dl/one.flac",
        filename: "one.flac",
        filesize: 40_000_000,
      });
    }
    return new Response("not found", { status: 404 });
  });

  return { impl, calls, torrents };
}

/**
 * A fake clock driven by `sleep`, so the provider's wall-clock deadline is
 * exercised deterministically and no test spends real time. Each poll also
 * charges a round-trip, because on the live API that is where the budget
 * actually goes (~260ms per call, measured).
 */
const providerOf = (fake: ReturnType<typeof fakeRd>, over: Partial<{ settleBudgetMs: number }> = {}) => {
  let clock = 0;
  return new RealDebridProvider({
    fetchImpl: fake.impl as unknown as typeof fetch,
    sleep: async (ms) => {
      clock += ms + 260;
    },
    now: () => clock,
    settleBudgetMs: over.settleBudgetMs ?? 3_000,
  });
};

describe("RealDebridProvider.checkCache", () => {
  it("selects only audio files, never the whole torrent", async () => {
    const fake = fakeRd();
    await providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY");

    const select = fake.calls.find((c) => c.path.includes("/selectFiles/"))!;
    const chosen = new URLSearchParams(select.body!).get("files");
    // Files 0 and 1 are FLAC; file 2 is cover art. "all" would make RD fetch it.
    expect(chosen).toBe("0,1");
    expect(chosen).not.toBe("all");
  });

  it("reports cached with the selected file list and a reusable handle", async () => {
    const result = await providerOf(fakeRd()).checkCache({ infoHash: HASH }, "RDKEY");

    expect(result.cached).toBe(true);
    expect(result.files?.map((f) => f.path)).toEqual(["Album/01 - One.flac", "Album/02 - Two.flac"]);
    expect(result.handle).toBe("T1");
  });

  it("deletes the torrent it added when the answer is 'not cached'", async () => {
    const fake = fakeRd({ settledStatus: "downloading" });
    const result = await providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY");

    expect(result.cached).toBe(false);
    // The whole point: a cache check must not leave a download running.
    expect(fake.calls.some((c) => c.method === "DELETE" && c.path.includes("/torrents/delete/"))).toBe(true);
    expect(fake.torrents.size).toBe(0);
  });

  it("deletes what it added when the torrent has no audio files at all", async () => {
    const fake = fakeRd({ files: [{ id: 0, path: "/Album/scans.rar" }, { id: 1, path: "/Album/cover.jpg" }] });
    const result = await providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY");

    expect(result.cached).toBe(false);
    expect(fake.calls.some((c) => c.path.includes("/torrents/delete/"))).toBe(true);
    // Nothing was ever selected, so RD was never told to fetch anything.
    expect(fake.calls.some((c) => c.path.includes("/selectFiles/"))).toBe(false);
  });

  it("deletes what it added when the flow fails partway", async () => {
    const fake = fakeRd({ preSelectStatuses: ["magnet_error"] });
    await expect(providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY")).rejects.toThrow(/unusable/);
    expect(fake.torrents.size).toBe(0);
  });

  it("waits through magnet_conversion before selecting", async () => {
    const fake = fakeRd({ preSelectStatuses: ["magnet_conversion", "magnet_conversion"] });
    const result = await providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY");
    expect(result.cached).toBe(true);
  });

  it("gives up rather than waiting out a real download", async () => {
    const fake = fakeRd({ settledStatus: "downloading" });
    // A zero budget means the in-progress poll loop cannot run at all.
    const result = await providerOf(fake, { settleBudgetMs: 0 }).checkCache({ infoHash: HASH }, "RDKEY");
    expect(result.cached).toBe(false);
  });

  it("bounds the whole check by wall clock, add and selection included", async () => {
    // Two rounds of getting this wrong, both caught by measurement rather than
    // review: counting poll *attempts* ignored the ~260ms round-trip each costs
    // (a "2.5s" budget ran 4.8s), and then starting the clock after the add left
    // three fixed round-trips outside it (misses cost up to 6.8s against "3s").
    // Here every call advances the clock, including the ones before polling.
    const fake = fakeRd({ settledStatus: "downloading" });
    let clock = 0;
    const provider = new RealDebridProvider({
      fetchImpl: (async (...args: Parameters<typeof fetch>) => {
        clock += 260; // every round-trip costs, not just the sleeps
        return fake.impl(...args);
      }) as unknown as typeof fetch,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      settleBudgetMs: 3_000,
    });

    const result = await provider.checkCache({ infoHash: HASH }, "RDKEY");
    expect(result.cached).toBe(false);
    // Budget + at most one overrunning poll + the cleanup delete, which is
    // deliberately outside the budget because it must always run.
    expect(clock).toBeLessThanOrEqual(3_000 + 660 + 260);
  });

  it("adds nothing when given a handle for a torrent already on the account", async () => {
    const fake = fakeRd();
    const result = await providerOf(fake).checkCache({ infoHash: HASH, handle: "EXISTING" }, "RDKEY");

    expect(result.cached).toBe(true);
    expect(result.handle).toBe("EXISTING");
    expect(fake.calls.some((c) => c.path.includes("addMagnet"))).toBe(false);
    expect(fake.calls.some((c) => c.method === "DELETE")).toBe(false);
  });

  it("sends the caller's key as the Bearer token on every request", async () => {
    const seen: (string | null)[] = [];
    const fake = fakeRd({ onAuth: (k) => seen.push(k) });
    await providerOf(fake).checkCache({ infoHash: HASH }, "USER-OWN-KEY");

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === "Bearer USER-OWN-KEY")).toBe(true);
  });
});

describe("RealDebridProvider.listCached", () => {
  it("reports only downloaded torrents whose hash we asked about, and mutates nothing", async () => {
    const fake = fakeRd({
      accountList: [
        { id: "A", hash: HASH.toUpperCase(), status: "downloaded" },
        { id: "B", hash: "b".repeat(40), status: "downloaded" },
        { id: "C", hash: "c".repeat(40), status: "downloading" },
      ],
    });
    const found = await providerOf(fake).listCached([HASH, "c".repeat(40), "d".repeat(40)], "RDKEY");

    expect(found.get(HASH)).toBe("A"); // matched case-insensitively
    expect(found.has("c".repeat(40))).toBe(false); // still downloading
    expect(found.has("d".repeat(40))).toBe(false); // not on the account
    expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
  });

  it("stops paging once a short page proves the list is exhausted", async () => {
    const fake = fakeRd({ accountList: [{ id: "A", hash: HASH, status: "downloaded" }] });
    await providerOf(fake).listCached([HASH, "b".repeat(40)], "RDKEY");
    expect(fake.calls.filter((c) => c.path.includes("/torrents?")).length).toBe(1);
  });
});

describe("RealDebridProvider.resolveFile", () => {
  it("unrestricts the link that matches the chosen file id", async () => {
    const fake = fakeRd();
    const { handle } = await providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY");
    const link = await providerOf(fake).resolveFile({ infoHash: HASH, handle }, "1", "RDKEY");

    expect(link.url).toBe("https://rd.example/dl/one.flac");
    expect(link.filename).toBe("one.flac");
    expect(link.sizeBytes).toBe(40_000_000);
  });

  it("does not re-add a torrent when carrying a handle", async () => {
    const fake = fakeRd();
    await providerOf(fake).resolveFile({ infoHash: HASH, handle: "EXISTING" }, "0", "RDKEY");
    expect(fake.calls.filter((c) => c.path.includes("addMagnet")).length).toBe(0);
  });

  it("refuses to guess when RD's links no longer line up with the selected files", async () => {
    // Two files selected, one link back — index mapping is meaningless here.
    const impl = vi.fn(async (input: string | URL | Request) => {
      const path = String(input).replace(/^https?:\/\/[^/]+/, "");
      if (path.includes("/torrents/info/")) {
        return json({
          status: "downloaded",
          files: [
            { id: 0, path: "/a.flac", selected: 1 },
            { id: 1, path: "/b.flac", selected: 1 },
          ],
          links: ["https://rd.example/only-one"],
        });
      }
      return new Response("nope", { status: 404 });
    });
    const provider = new RealDebridProvider({ fetchImpl: impl as unknown as typeof fetch, sleep: async () => {} });

    await expect(provider.resolveFile({ infoHash: HASH, handle: "T1" }, "1", "RDKEY")).rejects.toThrow(
      /file\/link mismatch/,
    );
  });

  it("refuses to resolve an uncached torrent", async () => {
    const fake = fakeRd({ settledStatus: "downloading" });
    await expect(
      providerOf(fake).resolveFile({ infoHash: HASH, handle: "T1" }, "0", "RDKEY"),
    ).rejects.toThrow(/not cached/);
  });

  it("rejects a non-https download URL rather than handing it to the player", async () => {
    const fake = fakeRd({ download: "http://rd.example/insecure.flac" });
    await expect(
      providerOf(fake).resolveFile({ infoHash: HASH, handle: "T1" }, "0", "RDKEY"),
    ).rejects.toThrow(/non-https/);
  });

  it("surfaces auth failure as a distinguishable DebridError", async () => {
    const fake = fakeRd({ authFails: true });
    await expect(
      providerOf(fake).resolveFile({ infoHash: HASH, handle: "T1" }, "0", "BADKEY"),
    ).rejects.toMatchObject({ isAuth: true } satisfies Partial<DebridError>);
  });
});

describe("Real-Debrid in-band error envelope", () => {
  it("treats an auth error_code in a 200 body as an auth failure", async () => {
    const fake = fakeRd({ errorBody: { error: "bad_token", error_code: 8 } });
    await expect(providerOf(fake).checkCache({ infoHash: HASH }, "BADKEY")).rejects.toMatchObject({
      isAuth: true,
      code: 8,
    });
  });

  it("labels the codes our own traffic shape can provoke", async () => {
    for (const [code, label] of [
      [21, /too many active downloads/],
      [34, /rate limited/],
      [35, /infringing file/],
    ] as const) {
      const fake = fakeRd({ errorBody: { error: "x", error_code: code } });
      await expect(providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY")).rejects.toMatchObject({
        isAuth: false,
        code,
      });
      await expect(providerOf(fake).checkCache({ infoHash: HASH }, "RDKEY")).rejects.toThrow(label);
    }
  });
});
