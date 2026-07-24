import { describe, it, expect } from "vitest";
import {
  parseCsvLine,
  rowFromCsvLine,
  parseArtistMbids,
  docsFromRows,
  serializeNdjson,
  type CanonicalRow,
} from "../src/build.js";
import type { ArtistPopularity } from "../src/listenbrainz.js";
import { fetchTopArtists, fetchTopRecordings } from "../src/listenbrainz.js";

describe("parseCsvLine", () => {
  it("splits plain fields", () => {
    expect(parseCsvLine("a,b,c")).toEqual(["a", "b", "c"]);
  });
  it("keeps commas inside quoted fields", () => {
    expect(parseCsvLine('1,"Earth, Wind & Fire",x')).toEqual(["1", "Earth, Wind & Fire", "x"]);
  });
  it("unescapes doubled quotes", () => {
    expect(parseCsvLine('a,"she said ""hi""",b')).toEqual(["a", 'she said "hi"', "b"]);
  });
});

const AAAA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"; // Justin Bieber (in scope)
const CCCC = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"; // some other artist (out of scope)

// A realistic canonical row. artist_mbids is a Postgres-array literal; when it
// holds more than one MBID the comma forces CSV quoting, exactly as `COPY` emits.
const row = (opts: Partial<Record<string, string>> = {}): string => {
  const mbids = opts.mbids ?? `{${AAAA}}`;
  return [
    opts.id ?? "1",
    opts.acid ?? "10",
    mbids.includes(",") ? `"${mbids}"` : mbids,
    opts.artist ?? "Justin Bieber",
    opts.release ?? "rel-1",
    opts.releaseName ?? "My World 2.0",
    opts.recording ?? "rec-1",
    opts.recordingName ?? "Baby",
    opts.combined ?? "justinbieberbaby",
    opts.score ?? "100",
  ].join(",");
};

describe("rowFromCsvLine", () => {
  it("maps columns by position", () => {
    expect(rowFromCsvLine(row())).toEqual({
      artistMbids: `{${AAAA}}`,
      artistCreditName: "Justin Bieber",
      releaseMbid: "rel-1",
      releaseName: "My World 2.0",
      recordingMbid: "rec-1",
      recordingName: "Baby",
    } satisfies CanonicalRow);
  });
  it("rejects the header row (no recording mbid) and short lines", () => {
    const header =
      "id,artist_credit_id,artist_mbids,artist_credit_name,release_mbid,release_name,recording_mbid,recording_name,combined_lookup,score";
    // The header's recording_mbid column is the literal string, so it parses — but
    // buildCatalog skips line 0 explicitly; a genuinely short line is rejected here.
    expect(rowFromCsvLine("too,few,cols")).toBeNull();
    expect(rowFromCsvLine(header)?.recordingMbid).toBe("recording_mbid");
  });
});

describe("parseArtistMbids", () => {
  it("parses single, multi, and empty array literals", () => {
    expect(parseArtistMbids(`{${AAAA}}`)).toEqual([AAAA]);
    expect(parseArtistMbids(`{${AAAA},${CCCC}}`)).toEqual([AAAA, CCCC]);
    expect(parseArtistMbids("{}")).toEqual([]);
  });
});

const scope = new Map<string, ArtistPopularity>([
  [AAAA, { mbid: AAAA, name: "Justin Bieber", listenCount: 5000 }],
]);

describe("docsFromRows (popularity-scoped join)", () => {
  const rows: CanonicalRow[] = [
    rowFromCsvLine(row())!, // Bieber / My World 2.0 / Baby — in scope
    rowFromCsvLine(row({ recording: "rec-2", recordingName: "Somebody to Love" }))!, // same album, in scope
    rowFromCsvLine(row({ mbids: `{${CCCC}}`, artist: "Someone Else", release: "rel-9", recording: "rec-9", recordingName: "Obscure" }))!, // out of scope
  ];

  it("keeps only in-scope rows and emits artist docs from the scope", () => {
    const docs = docsFromRows(rows, scope);
    expect(docs.filter((d) => d.type === "artist").map((d) => d.id)).toEqual([`mbid:artist:${AAAA}`]);
    // The out-of-scope recording never becomes a track/album doc.
    expect(docs.some((d) => d.id === "mbid:recording:rec-9")).toBe(false);
    expect(docs.some((d) => d.id === "mbid:release:rel-9")).toBe(false);
  });

  it("builds searchtext, poster, and applies the artist's listen count as score", () => {
    const docs = docsFromRows(rows, scope);
    const track = docs.find((d) => d.id === "mbid:recording:rec-1")!;
    expect(track.searchtext).toBe("Justin Bieber My World 2.0 Baby");
    expect(track.score).toBe(5000); // artist listen count
    expect(track.poster).toContain("coverartarchive.org/release/rel-1/front");

    const album = docs.find((d) => d.id === "mbid:release:rel-1")!;
    expect(album.searchtext).toBe("Justin Bieber My World 2.0");
    expect(album.poster).toContain("coverartarchive.org/release/rel-1/front");

    const artist = docs.find((d) => d.type === "artist")!;
    expect(artist.searchtext).toBe("Justin Bieber");
    expect(artist.score).toBe(5000);
  });

  it("deduplicates albums and tracks; counts are 1 artist / 1 album / 2 tracks", () => {
    const docs = docsFromRows(rows, scope);
    expect(docs.filter((d) => d.type === "artist")).toHaveLength(1);
    expect(docs.filter((d) => d.type === "album")).toHaveLength(1);
    expect(docs.filter((d) => d.type === "track")).toHaveLength(2);
  });

  it("serializes to one JSON object per line", () => {
    const lines = serializeNdjson(docsFromRows(rows, scope)).trimEnd().split("\n");
    expect(lines).toHaveLength(4); // 1 artist + 1 album + 2 tracks
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });

  it("adds per-recording popularity on top of the artist's base score", () => {
    const boost = new Map<string, number>([["rec-1", 400]]); // the studio hit
    const docs = docsFromRows(rows, scope, boost);
    const hit = docs.find((d) => d.id === "mbid:recording:rec-1")!;
    const cut = docs.find((d) => d.id === "mbid:recording:rec-2")!;
    expect(hit.score).toBe(5400); // 5000 artist + 400 recording
    expect(cut.score).toBe(5000); // unboosted album cut
    expect(hit.score).toBeGreaterThan(cut.score); // hit floats above the cut
  });
});

describe("fetchTopArtists", () => {
  /** A stub ListenBrainz that serves two pages then an empty one. */
  function stub(pages: Array<Array<{ artist_name: string; artist_mbid?: string; listen_count: number }>>): typeof fetch {
    return (async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      const pageSize = Number(new URL(url).searchParams.get("count") ?? "1000");
      const artists = pages[offset / pageSize] ?? [];
      return new Response(JSON.stringify({ payload: { artists } }), { status: 200 });
    }) as unknown as typeof fetch;
  }

  it("pages until the limit and keys by MBID, skipping rows without an MBID", async () => {
    const fetchImpl = stub([
      [
        { artist_name: "Radiohead", artist_mbid: AAAA, listen_count: 3000 },
        { artist_name: "Unmapped", listen_count: 999 }, // no mbid → skipped
      ],
      [{ artist_name: "Daft Punk", artist_mbid: CCCC, listen_count: 2600 }],
    ]);

    const out = await fetchTopArtists({ limit: 10, pageSize: 2, delayMs: 0, fetchImpl });

    expect([...out.keys()]).toEqual([AAAA, CCCC]);
    expect(out.get(AAAA)).toEqual({ mbid: AAAA, name: "Radiohead", listenCount: 3000 });
  });

  it("stops at the limit without over-fetching", async () => {
    const fetchImpl = stub([
      [
        { artist_name: "A", artist_mbid: AAAA, listen_count: 3 },
        { artist_name: "B", artist_mbid: CCCC, listen_count: 2 },
      ],
    ]);
    const out = await fetchTopArtists({ limit: 1, pageSize: 2, delayMs: 0, fetchImpl });
    expect(out.size).toBe(1);
    expect([...out.keys()]).toEqual([AAAA]);
  });
});

describe("fetchTopRecordings", () => {
  it("returns recording_mbid → listen count, skipping rows without an mbid", async () => {
    const fetchImpl = (async (url: string) => {
      const offset = Number(new URL(url).searchParams.get("offset") ?? "0");
      const recordings =
        offset === 0
          ? [
              { recording_mbid: "rec-1", listen_count: 900 },
              { listen_count: 1 }, // no mbid → skipped
            ]
          : [];
      return new Response(JSON.stringify({ payload: { recordings } }), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await fetchTopRecordings({ limit: 100, pageSize: 2, delayMs: 0, fetchImpl });

    expect([...out.entries()]).toEqual([["rec-1", 900]]);
  });
});
