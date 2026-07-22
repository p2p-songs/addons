import { describe, it, expect } from "vitest";
import { pickFile, parseFileNumbering, fuzzyScore, FUZZY_THRESHOLD } from "../src/pick-file.js";
import type { DebridFile } from "../src/debrid/types.js";
import type { TrackContext } from "../src/metadata.js";

const f = (id: string, path: string, sizeBytes?: number): DebridFile =>
  sizeBytes === undefined ? { id, path } : { id, path, sizeBytes };

/** A typical single-disc FLAC album rip, plus the non-audio clutter. */
const albumFiles: DebridFile[] = [
  f("1", "Daft Punk - Discovery (2001)/01 - One More Time.flac", 40_000_000),
  f("2", "Daft Punk - Discovery (2001)/02 - Aerodynamic.flac", 35_000_000),
  f("3", "Daft Punk - Discovery (2001)/03 - Digital Love.flac", 50_000_000),
  f("4", "Daft Punk - Discovery (2001)/cover.jpg", 2_000_000),
  f("5", "Daft Punk - Discovery (2001)/Discovery.log", 5_000),
  f("6", "Daft Punk - Discovery (2001)/Discovery.cue", 3_000),
];

const withAlbum = (over: Partial<TrackContext>): TrackContext => ({
  artist: "Daft Punk",
  album: "Discovery",
  title: "Digital Love",
  disc: 1,
  position: "3",
  hasAlbumContext: true,
  ...over,
});

describe("pickFile — disc + position (deterministic)", () => {
  it("selects the file at the requested track position", () => {
    const match = pickFile(albumFiles, withAlbum({ title: "Digital Love", position: "3" }));
    expect(match?.file.id).toBe("3");
    expect(match?.strategy).toBe("disc-position");
    expect(match?.confidence).toBeGreaterThan(0.9);
  });

  it("ignores cover art, logs and cue sheets", () => {
    const match = pickFile(albumFiles, withAlbum({ position: "1", title: "One More Time" }));
    expect(match?.file.path).toMatch(/\.flac$/);
  });

  it("does not fall for 'largest file' — it picks by position, not size", () => {
    // Track 1 is not the largest (track 3 is); position must still win.
    const match = pickFile(albumFiles, withAlbum({ position: "1", title: "One More Time" }));
    expect(match?.file.id).toBe("1");
  });

  it("handles a vinyl-style position ('A4' → track 4)", () => {
    const vinyl: DebridFile[] = [
      f("a", "Album/A1 - Side A Opener.flac"),
      f("b", "Album/A4 - Fourth Track.flac"),
    ];
    const match = pickFile(vinyl, withAlbum({ position: "A4", title: "Fourth Track", disc: 1 }));
    expect(match?.file.id).toBe("b");
  });

  it("selects across discs using disc-track filenames", () => {
    const multi: DebridFile[] = [
      f("d1t3", "1-03 - Disc One Track Three.flac"),
      f("d2t3", "2-03 - Disc Two Track Three.flac"),
    ];
    const match = pickFile(multi, withAlbum({ disc: 2, position: "3", title: "Disc Two Track Three" }));
    expect(match?.file.id).toBe("d2t3");
  });

  it("selects across discs using disc folders", () => {
    const multi: DebridFile[] = [
      f("d1", "Disc 1/03 - Track.flac"),
      f("d2", "Disc 2/03 - Track.flac"),
    ];
    const match = pickFile(multi, withAlbum({ disc: 2, position: "3", title: "Track" }));
    expect(match?.file.id).toBe("d2");
  });

  it("falls back to fuzzy when album context exists but filenames have no numbers", () => {
    const noNumbers: DebridFile[] = [
      f("x", "Daft Punk/One More Time.flac"),
      f("y", "Daft Punk/Digital Love.flac"),
    ];
    const match = pickFile(noNumbers, withAlbum({ title: "Digital Love", position: "3" }));
    expect(match?.file.id).toBe("y");
    expect(match?.strategy).toBe("fuzzy");
  });
});

describe("pickFile — fuzzy (no album context)", () => {
  const radio = (title: string): TrackContext => ({ artist: "Daft Punk", title, hasAlbumContext: false });

  it("matches by title when there is no disc/position", () => {
    const match = pickFile(albumFiles, radio("Aerodynamic"));
    expect(match?.file.id).toBe("2");
    expect(match?.strategy).toBe("fuzzy");
  });

  it("takes a single-file torrent as the track", () => {
    const single = [f("only", "Daft Punk - One More Time (Radio Edit).mp3")];
    const match = pickFile(single, radio("One More Time"));
    expect(match?.file.id).toBe("only");
  });

  it("returns nothing when no file plausibly matches the title", () => {
    const unrelated = [f("z", "Some Other Artist - Totally Different Song.flac")];
    expect(pickFile(unrelated, radio("Digital Love"))).toBeUndefined();
  });

  it("does NOT auto-accept a lone file when album context was requested", () => {
    // With album context we expect a specific track; a single unrelated file
    // must not be blindly returned as if it were that track.
    const single = [f("only", "Something Unrelated.flac")];
    expect(pickFile(single, withAlbum({ title: "Digital Love", position: "3" }))).toBeUndefined();
  });
});

describe("pickFile — no audio", () => {
  it("returns undefined when the torrent has no audio files", () => {
    const noAudio = [f("a", "cover.jpg"), f("b", "info.nfo")];
    expect(pickFile(noAudio, withAlbum({}))).toBeUndefined();
  });
});

describe("parseFileNumbering", () => {
  it.each([
    ["03 - Title.flac", { track: 3 }],
    ["1-03 Title.flac", { disc: 1, track: 3 }],
    ["Disc 2/04 - Title.flac", { disc: 2, track: 4 }],
    ["CD1/A2. Title.mp3", { disc: 1, track: 2 }],
    ["07. Title.mp3", { track: 7 }],
    ["Album/Title Without Number.flac", {}],
  ])("parses %s", (path, expected) => {
    expect(parseFileNumbering(path)).toEqual(expected);
  });
});

describe("fuzzyScore", () => {
  it("is 1 for an exact match and high for containment", () => {
    expect(fuzzyScore("Digital Love", "Digital Love")).toBe(1);
    expect(fuzzyScore("03 - Digital Love (Remastered).flac", "Digital Love")).toBeGreaterThanOrEqual(FUZZY_THRESHOLD);
  });

  it("is low for unrelated titles", () => {
    expect(fuzzyScore("Aerodynamic", "Digital Love")).toBeLessThan(FUZZY_THRESHOLD);
  });
});

/**
 * A multi-format release: the same nine tracks shipped as FLAC, MP3, OGG and
 * WAV alongside artwork. This is not a contrived case — it is the exact shape of
 * the Internet Archive Live Music Archive item we probed, and it is common for
 * lossless music torrents generally. Every encoding matches "track 1" equally
 * well, so the tie has to be broken by the user's `preferFormats`.
 */
const multiFormatFiles: DebridFile[] = [
  f("1", "Jeremiah Hazed 2019-05-24/01 Two Bottles.flac", 180_000_000),
  f("2", "Jeremiah Hazed 2019-05-24/01 Two Bottles.mp3", 12_000_000),
  f("3", "Jeremiah Hazed 2019-05-24/01 Two Bottles.ogg", 10_000_000),
  f("4", "Jeremiah Hazed 2019-05-24/01 Two Bottles.wav", 520_000_000),
  f("5", "Jeremiah Hazed 2019-05-24/02 Song For You and Me.flac", 190_000_000),
  f("6", "Jeremiah Hazed 2019-05-24/02 Song For You and Me.wav", 540_000_000),
  f("7", "Jeremiah Hazed 2019-05-24/folder.png", 800_000),
];

describe("pickFile — several encodings of the same track", () => {
  const track = (over: Partial<TrackContext> = {}): TrackContext => ({
    artist: "Jeremiah Hazed",
    title: "Two Bottles",
    hasAlbumContext: true,
    position: "1",
    disc: 1,
    ...over,
  });

  it("honours preferFormats by disc+position", () => {
    const match = pickFile(multiFormatFiles, track(), ["FLAC", "MP3"]);
    expect(match?.file.path.endsWith(".flac")).toBe(true);
  });

  it("honours preferFormats by fuzzy title too", () => {
    const match = pickFile(multiFormatFiles, track({ hasAlbumContext: false, position: undefined }), ["FLAC", "MP3"]);
    expect(match?.file.path.endsWith(".flac")).toBe(true);
  });

  it("follows the user's order rather than a built-in quality ranking", () => {
    // Someone on metered storage genuinely wants the MP3; we are not the judge.
    const match = pickFile(multiFormatFiles, track(), ["MP3", "FLAC"]);
    expect(match?.file.path.endsWith(".mp3")).toBe(true);
  });

  it("never falls back to 'largest', which would always pick the WAV", () => {
    // The regression this guards: size was the tie-break, and WAV is
    // uncompressed, so it beat the FLAC every single time.
    for (const prefs of [["FLAC", "MP3"], ["MP3"], ["OGG"]]) {
      const match = pickFile(multiFormatFiles, track(), prefs);
      expect(match?.file.path.endsWith(".wav")).toBe(false);
    }
  });

  it("still returns something when no preferred format is present", () => {
    // Unlisted formats rank below listed ones but are never excluded.
    const match = pickFile(multiFormatFiles, track(), ["ALAC"]);
    expect(match).toBeDefined();
    expect(match?.file.path).toContain("Two Bottles");
  });

  it("prefers a better title match over a preferred format", () => {
    const files: DebridFile[] = [
      f("1", "Album/03 Digital Love.mp3", 8_000_000),
      f("2", "Album/04 Something Else.flac", 40_000_000),
    ];
    const match = pickFile(files, { artist: "Daft Punk", title: "Digital Love", hasAlbumContext: false }, ["FLAC"]);
    expect(match?.file.path).toContain("Digital Love");
  });
});
