import { describe, it, expect } from "vitest";
import { normalize, scoreCandidate, rankCandidates } from "../src/match.js";
import type { Candidate, TrackQuery } from "../src/sources/types.js";

const q: TrackQuery = { artist: "Kevin MacLeod", title: "Cipher", durationMs: 120000 };
const cand = (over: Partial<Candidate>): Candidate => ({
  source: "internet-archive",
  title: "Cipher",
  artist: "Kevin MacLeod",
  url: "https://archive.org/download/x/cipher.mp3",
  format: "MP3",
  durationMs: 120000,
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
});
