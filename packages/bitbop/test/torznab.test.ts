import { describe, it, expect, vi } from "vitest";
import { TorznabIndexer, parseTorznab, buildQueryString } from "../src/indexers/torznab.js";

const RSS = `<?xml version="1.0" encoding="UTF-8"?>
<rss xmlns:torznab="http://torznab.com/schemas/2015/feed">
<channel>
  <item>
    <title>Daft Punk - Random Access Memories (2013) [FLAC]</title>
    <enclosure url="magnet:?xt=urn:btih:0123456789ABCDEF0123456789ABCDEF01234567&dn=x" type="application/x-bittorrent" />
    <size>523456789</size>
    <torznab:attr name="seeders" value="42" />
    <torznab:attr name="infohash" value="0123456789ABCDEF0123456789ABCDEF01234567" />
  </item>
  <item>
    <title><![CDATA[Justice - Cross [MP3 320]]]></title>
    <torznab:attr name="magneturl" value="magnet:?xt=urn:btih:89abcdef0123456789abcdef0123456789abcdef" />
    <torznab:attr name="size" value="98765432" />
  </item>
  <item>
    <title>No hash here — should be dropped</title>
    <size>123</size>
  </item>
</channel>
</rss>`;

describe("parseTorznab", () => {
  it("extracts candidates, normalizing the infohash to lowercase", () => {
    const candidates = parseTorznab(RSS, "test-indexer");
    expect(candidates).toHaveLength(2);

    const [first, second] = candidates;
    expect(first!.infoHash).toBe("0123456789abcdef0123456789abcdef01234567");
    expect(first!.sizeBytes).toBe(523456789);
    expect(first!.seeders).toBe(42);
    expect(first!.format).toBe("FLAC");
    expect(first!.indexer).toBe("test-indexer");

    // second item: hash lifted from magneturl, CDATA title decoded, MP3 detected
    expect(second!.infoHash).toBe("89abcdef0123456789abcdef0123456789abcdef");
    expect(second!.title).toContain("Justice - Cross");
    expect(second!.format).toBe("MP3");
  });

  it("drops items with no usable infohash rather than emitting a dead candidate", () => {
    const candidates = parseTorznab(RSS, "x");
    expect(candidates.every((c) => /^[0-9a-f]{40}$/.test(c.infoHash))).toBe(true);
  });

  it("decodes XML entities in titles", () => {
    const xml = `<rss><channel><item>
      <title>Simon &amp; Garfunkel - Greatest Hits</title>
      <torznab:attr name="infohash" value="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" />
    </item></channel></rss>`;
    expect(parseTorznab(xml, "x")[0]!.title).toBe("Simon & Garfunkel - Greatest Hits");
  });

  it("returns nothing for an empty feed", () => {
    expect(parseTorznab(`<rss><channel></channel></rss>`, "x")).toEqual([]);
  });
});

describe("buildQueryString", () => {
  it("prefers album context, else falls back to the track", () => {
    expect(buildQueryString({ artist: "Daft Punk", album: "Discovery" })).toBe("Daft Punk Discovery");
    expect(buildQueryString({ artist: "Daft Punk", track: "One More Time" })).toBe("Daft Punk One More Time");
    expect(buildQueryString({ artist: "Daft Punk", album: "Discovery", track: "One More Time" })).toBe(
      "Daft Punk Discovery",
    );
  });
});

describe("TorznabIndexer", () => {
  it("sends the apikey and query, and parses the response", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("apikey")).toBe("SECRET");
      expect(url.searchParams.get("q")).toBe("Daft Punk Discovery");
      return new Response(RSS, { status: 200 });
    });
    const indexer = new TorznabIndexer(
      { url: "https://jackett.example/torznab", apiKey: "SECRET", name: "jackett" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    const results = await indexer.search({ artist: "Daft Punk", album: "Discovery" });
    expect(results).toHaveLength(2);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects on a non-2xx response so the resolver can isolate the failure", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));
    const indexer = new TorznabIndexer(
      { url: "https://jackett.example/torznab", apiKey: "SECRET" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    await expect(indexer.search({ artist: "x", track: "y" })).rejects.toThrow(/500/);
  });

  it("names itself from the config label, else the URL host", () => {
    const named = new TorznabIndexer({ url: "https://a.example/t", apiKey: "k", name: "mine" });
    const unnamed = new TorznabIndexer({ url: "https://a.example/t", apiKey: "k" });
    expect(named.name).toBe("mine");
    expect(unnamed.name).toBe("a.example");
  });
});
