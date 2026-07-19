import { describe, it, expect } from "vitest";
import { resolveStreams } from "../src/resolve.js";
import type { MetadataLookup, RecordingMeta } from "../src/metadata.js";
import type { Candidate, LegalSource, TrackQuery } from "../src/sources/types.js";
import type { RecordingId } from "@p2p-songs/addon-sdk";

const REC = "mbid:recording:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa" as RecordingId;

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
  ...over,
});

describe("resolveStreams", () => {
  it("returns [] when the recording can't be identified", async () => {
    const streams = await resolveStreams(REC, {
      metadata: { lookup: async () => undefined },
      sources: [source("s", [good()])],
    });
    expect(streams).toEqual([]);
  });

  it("maps ranked candidates to protocol stream objects", async () => {
    const streams = await resolveStreams(REC, { metadata: meta(), sources: [source("internet-archive", [good()])] });
    expect(streams).toHaveLength(1);
    expect(streams[0]!.url).toBe("https://archive.org/download/x/cipher.mp3");
    expect(streams[0]!.name).toBe("Internet Archive · MP3");
    expect(streams[0]!.behaviorHints?.filename).toBe("Kevin MacLeod - Cipher.mp3");
  });

  it("isolates a failing source — others still contribute", async () => {
    const streams = await resolveStreams(REC, {
      metadata: meta(),
      sources: [source("dead", new Error("network down")), source("ok", [good({ url: "https://ok/x.mp3" })])],
    });
    expect(streams.map((s) => s.url)).toEqual(["https://ok/x.mp3"]);
  });

  it("drops an unrelated result and a non-https url", async () => {
    const streams = await resolveStreams(REC, {
      metadata: meta(),
      sources: [
        source("s", [
          good({ title: "Some Unrelated Podcast", artist: "Nobody", url: "https://x/pod.mp3" }),
          good({ url: "http://insecure/x.mp3" }),
          good({ url: "https://ok/cipher.mp3" }),
        ]),
      ],
    });
    expect(streams.map((s) => s.url)).toEqual(["https://ok/cipher.mp3"]);
  });

  it("honors maxResults", async () => {
    const many = Array.from({ length: 20 }, (_, i) => good({ url: `https://ok/${i}.mp3` }));
    const streams = await resolveStreams(REC, { metadata: meta(), sources: [source("s", many)], maxResults: 3 });
    expect(streams).toHaveLength(3);
  });
});
