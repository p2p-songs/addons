import { describe, it, expect } from "vitest";
import { MusicBrainzApi, RateLimiter } from "../src/index.js";

const REL = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const REC = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const T1 = "11111111-1111-1111-1111-111111111111";
const T2 = "22222222-2222-2222-2222-222222222222";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

const opts = (fetchImpl: typeof fetch) => ({
  baseUrl: "https://mb.test/ws/2",
  fetchImpl,
  limiter: new RateLimiter(0, async () => {}),
  sleep: async () => {},
});

describe("MusicBrainzApi parsing", () => {
  it("flattens release media into tracks with disc + free-text position + recording split", async () => {
    const api = new MusicBrainzApi(
      "test/0.0",
      opts(
        fakeFetch({
          [`/release/${REL}`]: {
            id: REL,
            title: "Deluxe",
            date: "1997",
            "artist-credit": [{ name: "Some Artist" }],
            media: [
              { position: 1, tracks: [{ id: T1, number: "1", title: "Opening", length: 262000, recording: { id: REC } }] },
              { position: 2, tracks: [{ id: T2, number: "A4", title: "Reprise", recording: { id: REC, length: 260000 } }] },
            ],
          },
        }),
      ),
    );
    const rel = await api.getRelease(REL);
    expect(rel!.artist).toBe("Some Artist");
    expect(rel!.tracks[0]).toMatchObject({ trackId: T1, recordingId: REC, disc: 1, position: "1", durationMs: 262000 });
    expect(rel!.tracks[1]).toMatchObject({ trackId: T2, recordingId: REC, disc: 2, position: "A4", durationMs: 260000 });
  });

  it("joins artist-credit with joinphrases and parses recording length", async () => {
    const api = new MusicBrainzApi(
      "test/0.0",
      opts(
        fakeFetch({
          [`/recording/${REC}`]: { id: REC, title: "Collab", length: 200000, "artist-credit": [{ name: "A", joinphrase: " & " }, { name: "B" }] },
        }),
      ),
    );
    expect(await api.getRecording(REC)).toMatchObject({ id: REC, title: "Collab", artist: "A & B", durationMs: 200000 });
  });

  it("returns undefined on 404", async () => {
    const api = new MusicBrainzApi("t/0", opts((async () => new Response("", { status: 404 })) as typeof fetch));
    expect(await api.getArtist("x")).toBeUndefined();
  });

  it("retries on 503 then succeeds", async () => {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      if (calls === 1) return new Response("", { status: 503, headers: { "Retry-After": "0" } });
      return new Response(JSON.stringify({ id: REC, name: "Artist" }), { status: 200 });
    }) as typeof fetch;
    const api = new MusicBrainzApi("t/0", opts(fetchImpl));
    const artist = await api.getArtist(REC);
    expect(calls).toBe(2);
    expect(artist).toMatchObject({ id: REC, name: "Artist" });
  });
});
