import { describe, it, expect } from "vitest";
import { normalize, scoreCandidate, rankCandidates } from "../src/match.js";
import type { Candidate, TrackQuery } from "../src/sources/types.js";

const q: TrackQuery = { artist: "Kevin MacLeod", title: "Cipher", durationMs: 120000 };
const CC = "https://creativecommons.org/licenses/by/3.0/";
const cand = (over: Partial<Candidate>): Candidate => ({
  source: "internet-archive",
  title: "Cipher",
  artist: "Kevin MacLeod",
  url: "https://archive.org/download/x/cipher.mp3",
  format: "MP3",
  durationMs: 120000,
  license: CC,
  ...over,
});

describe("normalize", () => {
  it("lowercases, strips punctuation/diacritics and feat. noise", () => {
    expect(normalize("Café  Del  Mar!!")).toBe("cafe del mar");
    expect(normalize("Song (feat. Someone)")).toBe("song");
    expect(normalize("Track feat. X")).toBe("track");
  });
});

describe("scoreCandidate", () => {
  it("scores an exact match high and an unrelated one low", () => {
    expect(scoreCandidate(q, cand({}))).toBeGreaterThan(0.9);
    expect(scoreCandidate(q, cand({ title: "Totally Different", artist: "Someone Else" }))).toBeLessThan(0.5);
  });

  it("penalizes a large duration mismatch but doesn't reject on it alone", () => {
    const close = scoreCandidate(q, cand({ durationMs: 121000 }));
    const far = scoreCandidate(q, cand({ durationMs: 400000 }));
    expect(close).toBeGreaterThan(far);
  });
});

describe("rankCandidates", () => {
  it("drops below-threshold, sorts best-first, dedupes by url", () => {
    const ranked = rankCandidates(q, [
      cand({ title: "Unrelated Thing", artist: "Nobody", url: "https://x/a.mp3" }),
      cand({ url: "https://x/b.mp3" }),
      cand({ url: "https://x/b.mp3" }), // duplicate url
      cand({ title: "Cipher (Remastered)", url: "https://x/c.mp3" }),
    ]);
    const urls = ranked.map((c) => c.url);
    expect(urls).toContain("https://x/b.mp3");
    expect(urls).not.toContain("https://x/a.mp3"); // unrelated, dropped
    expect(new Set(urls).size).toBe(urls.length); // deduped
    expect(urls[0]).toBe("https://x/b.mp3"); // exact match ranks first
  });

  it("drops non-https candidates defensively", () => {
    const ranked = rankCandidates(q, [
      cand({ url: "http://insecure/x.mp3" }),
      cand({ url: "ftp://insecure/x.mp3" }),
      cand({ url: "https://ok/x.mp3" }),
    ]);
    expect(ranked.map((c) => c.url)).toEqual(["https://ok/x.mp3"]);
  });

  it("drops candidates without a recognized open license (A-006)", () => {
    const ranked = rankCandidates(q, [
      cand({ url: "https://no-license/x.mp3", license: undefined }),
      cand({ url: "https://all-rights/x.mp3", license: "All Rights Reserved" }),
      cand({ url: "https://cc/x.mp3", license: "https://creativecommons.org/licenses/by-sa/4.0/" }),
      cand({ url: "https://pd/x.mp3", license: "Public Domain" }),
    ]);
    expect(ranked.map((c) => c.url).sort()).toEqual(["https://cc/x.mp3", "https://pd/x.mp3"]);
  });

  it("drops an exact-title match from the wrong artist (A-006)", () => {
    const query = { artist: "Correct Artist", title: "Home", durationMs: 200000 };
    const ranked = rankCandidates(query, [
      cand({ artist: "Wrong Artist", title: "Home", durationMs: 200000, url: "https://x/wrong.mp3" }),
      cand({ artist: "Correct Artist", title: "Home", durationMs: 200000, url: "https://x/right.mp3" }),
    ]);
    expect(ranked.map((c) => c.url)).toEqual(["https://x/right.mp3"]);
  });

  it("still matches when artist is unknown on one side (can't gate)", () => {
    const query = { artist: "", title: "Home", durationMs: 200000 };
    const ranked = rankCandidates(query, [cand({ artist: "Someone", title: "Home", durationMs: 200000, url: "https://x/a.mp3" })]);
    expect(ranked).toHaveLength(1);
  });
});
