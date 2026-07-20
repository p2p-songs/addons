import { describe, it, expect } from "vitest";
import { resolveStreams } from "../src/resolve.js";
import type { MetadataLookup, RecordingMeta } from "../src/metadata.js";
import type { Candidate, LegalSource, TrackQuery } from "../src/sources/types.js";
import type { RecordingId } from "@p2p-songs/addon-sdk";

const REC = "mbid:recording:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as RecordingId;
const CC = "https://creativecommons.org/licenses/by/3.0/";

const meta = (m?: RecordingMeta): MetadataLookup => ({
  lookup: async () => m ?? { artist: "Kevin MacLeod", title: "Cipher", durationMs: 120000 },
});

function source(id: string, results: Candidate[] | Error): LegalSource {
  return {
    id,
    name: id,
    search: async (_q: TrackQuery) => {
      if (results instanceof Error) throw results;
      return results;
    },
  };
}

const good = (over: Partial<Candidate> = {}): Candidate => ({
  source: "internet-archive",
  title: "Cipher",
  artist: "Kevin MacLeod",
  url: "https://archive.org/download/x/cipher.mp3",
  format: "MP3",
  durationMs: 120000,
  license: CC,
  ...over,
});

describe("resolveStreams", () => {
  it("returns empty (not a source failure) when the recording can't be identified", async () => {
    const r = await resolveStreams(REC, { metadata: { lookup: async () => undefined }, sources: [source("s", [good()])] });
    expect(r.streams).toEqual([]);
    expect(r.allSourcesFailed).toBe(false);
  });

  it("maps ranked candidates to protocol stream objects", async () => {
    const r = await resolveStreams(REC, { metadata: meta(), sources: [source("internet-archive", [good()])] });
    expect(r.streams).toHaveLength(1);
    expect(r.streams[0]!.url).toBe("https://archive.org/download/x/cipher.mp3");
    expect(r.streams[0]!.name).toBe("Internet Archive · MP3 · CC BY 3.0");
    expect(r.streams[0]!.behaviorHints?.filename).toBe("Kevin MacLeod - Cipher.mp3");
    expect(r.allSourcesFailed).toBe(false);
  });

  it("isolates a partial failure — other sources still contribute", async () => {
    const r = await resolveStreams(REC, {
      metadata: meta(),
      sources: [source("dead", new Error("network down")), source("ok", [good({ url: "https://ok/x.mp3" })])],
    });
    expect(r.streams.map((s) => s.url)).toEqual(["https://ok/x.mp3"]);
    expect(r.allSourcesFailed).toBe(false);
  });

  it("flags a TOTAL source outage (every source failed) distinctly from no-match", async () => {
    const outage = await resolveStreams(REC, {
      metadata: meta(),
      sources: [source("a", new Error("down")), source("b", new Error("down"))],
    });
    expect(outage.streams).toEqual([]);
    expect(outage.allSourcesFailed).toBe(true);

    const noMatch = await resolveStreams(REC, { metadata: meta(), sources: [source("a", []), source("b", [])] });
    expect(noMatch.streams).toEqual([]);
    expect(noMatch.allSourcesFailed).toBe(false);
  });

  it("drops an unrelated result and a non-https url", async () => {
    const r = await resolveStreams(REC, {
      metadata: meta(),
      sources: [
        source("s", [
          good({ title: "Some Unrelated Podcast", artist: "Nobody", url: "https://x/pod.mp3" }),
          good({ url: "http://insecure/x.mp3" }),
          good({ url: "https://ok/cipher.mp3" }),
        ]),
      ],
    });
    expect(r.streams.map((s) => s.url)).toEqual(["https://ok/cipher.mp3"]);
  });

  it("honors maxResults", async () => {
    const many = Array.from({ length: 20 }, (_, i) => good({ url: `https://ok/${i}.mp3` }));
    const r = await resolveStreams(REC, { metadata: meta(), sources: [source("s", many)], maxResults: 3 });
    expect(r.streams).toHaveLength(3);
  });
});
