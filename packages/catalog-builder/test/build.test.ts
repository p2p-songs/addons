import { describe, it, expect } from "vitest";
import {
  parseCsvLine,
  rowFromCsvLine,
  parseArtistMbids,
  TopN,
  docsFromRows,
  serializeNdjson,
  type CanonicalRow,
} from "../src/build.js";

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

  it("yields an empty trailing field", () => {
    expect(parseCsvLine("a,b,")).toEqual(["a", "b", ""]);
  });
});

const HEADER =
  "id,artist_credit_id,artist_mbids,artist_credit_name,release_mbid,release_name,recording_mbid,recording_name,combined_lookup,score";

// A realistic canonical row. artist_mbids is a Postgres-array literal; when it
// holds more than one MBID the comma forces CSV quoting, exactly as `COPY` emits.
const row = (opts: Partial<Record<string, string>> = {}): string => {
  const mbids = opts.mbids ?? "{aaaa-artist}";
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
    const r = rowFromCsvLine(row());
    expect(r).toEqual({
      artistMbids: "{aaaa-artist}",
      artistCreditName: "Justin Bieber",
      releaseMbid: "rel-1",
      releaseName: "My World 2.0",
      recordingMbid: "rec-1",
      recordingName: "Baby",
      score: 100,
    } satisfies CanonicalRow);
  });

  it("rejects the header row (non-numeric score) and short/garbage lines", () => {
    // The header's score column is the literal "score" → not finite → rejected,
    // so buildCatalog needs no special-casing beyond skipping line 0.
    expect(rowFromCsvLine(HEADER)).toBeNull();
    expect(rowFromCsvLine("too,few,cols")).toBeNull();
  });
});

describe("parseArtistMbids", () => {
  it("parses a single-element array literal", () => {
    expect(parseArtistMbids("{aaaa}")).toEqual(["aaaa"]);
  });
  it("parses a multi-element array literal", () => {
    expect(parseArtistMbids("{aaaa,bbbb}")).toEqual(["aaaa", "bbbb"]);
  });
  it("is empty for an empty array", () => {
    expect(parseArtistMbids("{}")).toEqual([]);
  });
});

describe("TopN", () => {
  it("retains only the highest-scoring rows", () => {
    const top = new TopN(3);
    for (const score of [5, 1, 9, 3, 7, 2, 8]) {
      top.push({ ...(rowFromCsvLine(row({ score: String(score), recording: `r${score}` }))!) });
    }
    const scores = top
      .values()
      .map((r) => r.score)
      .sort((a, b) => b - a);
    expect(scores).toEqual([9, 8, 7]);
  });

  it("a zero limit keeps nothing", () => {
    const top = new TopN(0);
    top.push(rowFromCsvLine(row())!);
    expect(top.values()).toEqual([]);
  });
});

describe("docsFromRows", () => {
  const rows: CanonicalRow[] = [
    rowFromCsvLine(row())!, // Justin Bieber / My World 2.0 / Baby, single artist
    rowFromCsvLine(
      row({ recording: "rec-2", recordingName: "Somebody to Love", score: "90" }),
    )!, // same artist + album, another track
    rowFromCsvLine(
      row({ mbids: "{aaaa-artist,cccc-guest}", artist: "Justin Bieber feat. Ludacris", recording: "rec-3", recordingName: "Baby (Remix)", score: "50" }),
    )!, // joint credit
  ];

  it("derives unified artist/album/track docs with the right ids and searchtext", () => {
    const docs = docsFromRows(rows);
    const track = docs.find((d) => d.id === "mbid:recording:rec-1")!;
    expect(track.type).toBe("track");
    expect(track.searchtext).toBe("Justin Bieber My World 2.0 Baby");
    expect(track.docId).toBe("mbid_recording_rec-1");

    const album = docs.find((d) => d.id === "mbid:release:rel-1")!;
    expect(album.type).toBe("album");
    expect(album.searchtext).toBe("Justin Bieber My World 2.0");

    const artist = docs.find((d) => d.id === "mbid:artist:aaaa-artist")!;
    expect(artist.type).toBe("artist");
    expect(artist.searchtext).toBe("Justin Bieber");
  });

  it("deduplicates and keeps the highest score per entity", () => {
    const docs = docsFromRows(rows);
    // one artist, one album, three tracks
    expect(docs.filter((d) => d.type === "artist")).toHaveLength(1);
    expect(docs.filter((d) => d.type === "album")).toHaveLength(1);
    expect(docs.filter((d) => d.type === "track")).toHaveLength(3);
    // album score = its most popular track (100), not the last-seen (50)
    expect(docs.find((d) => d.type === "album")!.score).toBe(100);
  });

  it("does not create an artist doc for a joint credit", () => {
    const docs = docsFromRows(rows);
    // only the single-artist MBID seeds an artist doc; the guest never does
    expect(docs.filter((d) => d.type === "artist").map((d) => d.id)).toEqual(["mbid:artist:aaaa-artist"]);
  });

  it("serializes to one JSON object per line", () => {
    const ndjson = serializeNdjson(docsFromRows(rows));
    const lines = ndjson.trimEnd().split("\n");
    expect(lines).toHaveLength(5); // 1 artist + 1 album + 3 tracks
    expect(() => lines.forEach((l) => JSON.parse(l))).not.toThrow();
  });
});
