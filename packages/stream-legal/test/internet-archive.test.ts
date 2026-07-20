import { describe, it, expect } from "vitest";
import { InternetArchiveSource } from "../src/sources/internet-archive.js";

/** A fake `fetch` that serves canned IA advancedsearch + metadata JSON. */
function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
}

describe("InternetArchiveSource", () => {
  it("expands a search hit into direct https download candidates", async () => {
    const fetchImpl = fakeFetch({
      "advancedsearch.php": {
        response: { docs: [{ identifier: "KevinMacLeod_Cipher", title: "Cipher", creator: "Kevin MacLeod", licenseurl: "https://creativecommons.org/licenses/by/3.0/" }] },
      },
      "metadata/KevinMacLeod_Cipher": {
        metadata: { creator: "Kevin MacLeod", licenseurl: "https://creativecommons.org/licenses/by/3.0/" },
        files: [
          { name: "Cipher.mp3", format: "VBR MP3", title: "Cipher", length: "120.5" },
          { name: "Cipher.flac", format: "FLAC", title: "Cipher", length: "2:00" },
          { name: "cover.jpg", format: "JPEG" }, // non-audio, ignored
        ],
      },
    });

    const source = new InternetArchiveSource(fetchImpl);
    const candidates = await source.search({ artist: "Kevin MacLeod", title: "Cipher", durationMs: 120000 });

    expect(candidates).toHaveLength(2);
    const mp3 = candidates.find((c) => c.format === "MP3")!;
    expect(mp3.url).toBe("https://archive.org/download/KevinMacLeod_Cipher/Cipher.mp3");
    expect(mp3.durationMs).toBe(120500);
    expect(mp3.license).toBe("https://creativecommons.org/licenses/by/3.0/");
    const flac = candidates.find((c) => c.format === "FLAC")!;
    expect(flac.durationMs).toBe(120000); // "2:00" parsed
    expect(candidates.every((c) => c.url.startsWith("https://archive.org/download/"))).toBe(true);
  });

  it("emits nothing for an item with no recognized open license (A-006 fail-closed)", async () => {
    const fetchImpl = fakeFetch({
      "advancedsearch.php": { response: { docs: [{ identifier: "unlicensed", title: "Song", creator: "Someone" }] } },
      "metadata/unlicensed": {
        metadata: { creator: "Someone" }, // no licenseurl
        files: [{ name: "song.mp3", format: "VBR MP3", length: "120" }],
      },
    });
    const candidates = await new InternetArchiveSource(fetchImpl).search({ artist: "Someone", title: "Song" });
    expect(candidates).toEqual([]);
  });

  it("throws on a failed search (resolver isolates it)", async () => {
    const fetchImpl = (async () => new Response("err", { status: 500 })) as typeof fetch;
    await expect(new InternetArchiveSource(fetchImpl).search({ artist: "a", title: "b" })).rejects.toThrow();
  });
});
