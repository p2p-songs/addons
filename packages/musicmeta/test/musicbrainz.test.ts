import { describe, it, expect } from "vitest";
import { MusicBrainzApi } from "../src/musicbrainz.js";
import { UUID } from "./fakes.js";

function fakeFetch(routes: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    const key = Object.keys(routes).find((k) => url.includes(k));
    if (!key) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(routes[key]), { status: 200 });
  }) as typeof fetch;
}

describe("MusicBrainzApi parsing", () => {
  it("flattens release media into tracks with disc + free-text position + recording split", async () => {
    const api = new MusicBrainzApi(
      "test/0.0",
      "https://mb.test/ws/2",
      fakeFetch({
        [`/release/${UUID.release}`]: {
          id: UUID.release,
          title: "Deluxe",
          date: "1997",
          "artist-credit": [{ name: "Some Artist" }],
          media: [
            { position: 1, tracks: [{ id: UUID.trackD1, number: "1", title: "Opening", length: 262000, recording: { id: UUID.rec1 } }] },
            { position: 2, tracks: [{ id: UUID.trackD2, number: "A4", title: "Reprise", recording: { id: UUID.rec1, length: 260000 } }] },
          ],
        },
      }),
    );
    const rel = await api.getRelease(UUID.release);
    expect(rel!.artist).toBe("Some Artist");
    expect(rel!.tracks).toHaveLength(2);
    expect(rel!.tracks[0]).toMatchObject({ trackId: UUID.trackD1, recordingId: UUID.rec1, disc: 1, position: "1", durationMs: 262000 });
    // Second track: distinct track id, same recording, disc 2, free-text position, duration from recording.
    expect(rel!.tracks[1]).toMatchObject({ trackId: UUID.trackD2, recordingId: UUID.rec1, disc: 2, position: "A4", durationMs: 260000 });
  });

  it("joins artist-credit with joinphrases and parses recording length", async () => {
    const api = new MusicBrainzApi(
      "test/0.0",
      "https://mb.test/ws/2",
      fakeFetch({
        [`/recording/${UUID.rec1}`]: {
          id: UUID.rec1,
          title: "Collab",
          length: 200000,
          "artist-credit": [{ name: "A", joinphrase: " & " }, { name: "B" }],
        },
      }),
    );
    const rec = await api.getRecording(UUID.rec1);
    expect(rec).toMatchObject({ id: UUID.rec1, title: "Collab", artist: "A & B", durationMs: 200000 });
  });

  it("returns undefined on 404", async () => {
    const api = new MusicBrainzApi("t/0", "https://mb.test/ws/2", (async () => new Response("", { status: 404 })) as typeof fetch);
    expect(await api.getArtist(UUID.artist)).toBeUndefined();
  });
});
