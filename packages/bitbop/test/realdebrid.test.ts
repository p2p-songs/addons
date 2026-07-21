import { describe, it, expect, vi } from "vitest";
import { RealDebridProvider } from "../src/debrid/realdebrid.js";
import { DebridError } from "../src/debrid/types.js";

/**
 * A fake Real-Debrid modeling the addMagnet → selectFiles → info → unrestrict
 * sequence, so we exercise the whole flow without a network or an account.
 */
function fakeRd(opts: {
  status?: string;
  files?: { id: number; path: string; bytes?: number; selected?: number }[];
  links?: string[];
  download?: string;
  authFails?: boolean;
  onAuth?: (key: string | null) => void;
}) {
  const status = opts.status ?? "downloaded";
  const files = opts.files ?? [
    { id: 0, path: "/Album/01 - One.flac", bytes: 40_000_000, selected: 1 },
    { id: 1, path: "/Album/02 - Two.flac", bytes: 42_000_000, selected: 1 },
    { id: 2, path: "/Album/cover.jpg", bytes: 500_000, selected: 1 },
  ];
  const links = opts.links ?? ["https://rd.example/link-0", "https://rd.example/link-1", "https://rd.example/link-2"];

  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const auth = new Headers(init?.headers).get("authorization");
    opts.onAuth?.(auth);
    if (opts.authFails) return new Response("denied", { status: 401 });

    if (url.endsWith("/torrents/addMagnet")) return json({ id: "TORRENT1" });
    if (url.includes("/torrents/selectFiles/")) return new Response(null, { status: 204 });
    if (url.includes("/torrents/info/")) return json({ status, files, links });
    if (url.endsWith("/unrestrict/link")) {
      return json({ download: opts.download ?? "https://rd.example/dl/one.flac", filename: "one.flac", filesize: 40_000_000 });
    }
    return new Response("not found", { status: 404 });
  });
}

const json = (v: unknown): Response =>
  new Response(JSON.stringify(v), { status: 200, headers: { "content-type": "application/json" } });

describe("RealDebridProvider.checkCache", () => {
  it("reports cached with the selected audio file list", async () => {
    const provider = new RealDebridProvider({ fetchImpl: fakeRd({ status: "downloaded" }) as unknown as typeof fetch });
    const result = await provider.checkCache("0123456789abcdef0123456789abcdef01234567", "RDKEY");

    expect(result.cached).toBe(true);
    expect(result.files?.map((f) => f.path)).toEqual(["Album/01 - One.flac", "Album/02 - Two.flac", "Album/cover.jpg"]);
    expect(result.files?.[0]!.id).toBe("0");
  });

  it("reports not-cached when the torrent still needs downloading", async () => {
    const provider = new RealDebridProvider({ fetchImpl: fakeRd({ status: "downloading" }) as unknown as typeof fetch });
    const result = await provider.checkCache("0123456789abcdef0123456789abcdef01234567", "RDKEY");
    expect(result.cached).toBe(false);
  });

  it("sends the caller's key as the Bearer token on every request", async () => {
    const seen: (string | null)[] = [];
    const provider = new RealDebridProvider({
      fetchImpl: fakeRd({ onAuth: (k) => seen.push(k) }) as unknown as typeof fetch,
    });
    await provider.checkCache("0123456789abcdef0123456789abcdef01234567", "USER-OWN-KEY");
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((h) => h === "Bearer USER-OWN-KEY")).toBe(true);
  });
});

describe("RealDebridProvider.resolveFile", () => {
  it("unrestricts the link that matches the chosen file id", async () => {
    const provider = new RealDebridProvider({ fetchImpl: fakeRd({}) as unknown as typeof fetch });
    const link = await provider.resolveFile("0123456789abcdef0123456789abcdef01234567", "1", "RDKEY");
    expect(link.url).toBe("https://rd.example/dl/one.flac");
    expect(link.filename).toBe("one.flac");
    expect(link.sizeBytes).toBe(40_000_000);
  });

  it("refuses to resolve an uncached torrent", async () => {
    const provider = new RealDebridProvider({ fetchImpl: fakeRd({ status: "downloading" }) as unknown as typeof fetch });
    await expect(provider.resolveFile("0123456789abcdef0123456789abcdef01234567", "0", "RDKEY")).rejects.toThrow(
      /not cached/,
    );
  });

  it("rejects a non-https download URL rather than handing it to the player", async () => {
    const provider = new RealDebridProvider({
      fetchImpl: fakeRd({ download: "http://rd.example/insecure.flac" }) as unknown as typeof fetch,
    });
    await expect(provider.resolveFile("0123456789abcdef0123456789abcdef01234567", "0", "RDKEY")).rejects.toThrow(
      /non-https/,
    );
  });

  it("surfaces auth failure as a distinguishable DebridError", async () => {
    const provider = new RealDebridProvider({ fetchImpl: fakeRd({ authFails: true }) as unknown as typeof fetch });
    await expect(
      provider.resolveFile("0123456789abcdef0123456789abcdef01234567", "0", "BADKEY"),
    ).rejects.toMatchObject({ isAuth: true } satisfies Partial<DebridError>);
  });
});
