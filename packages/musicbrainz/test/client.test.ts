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

describe("browseArtistReleases (discography)", () => {
  const ARTIST = "cccccccc-cccc-cccc-cccc-cccccccccccc";
  const group = (id: string, primary?: string, secondary?: string[]) => ({
    id,
    ...(primary ? { "primary-type": primary } : {}),
    ...(secondary ? { "secondary-types": secondary } : {}),
  });

  /** Serve one page of releases, recording the URLs asked for. */
  const pagedFetch = (pages: unknown[][], asked: string[]): typeof fetch =>
    (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      asked.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      const releases = pages[offset / 100] ?? [];
      return new Response(JSON.stringify({ releases, "release-count": pages.flat().length }), { status: 200 });
    }) as typeof fetch;

  it("keeps studio albums and drops live records, compilations and non-albums", async () => {
    // The failure this guards: without the secondary-types check, browsing a
    // well-documented artist returns mostly bootlegs and radio sessions —
    // observed live as 25 rows containing zero studio albums.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      { id: "r1", title: "Studio One", date: "1997-05-21", "release-group": group("g1", "Album") },
      { id: "r2", title: "Live At Wherever", date: "1998-01-01", "release-group": group("g2", "Album", ["Live"]) },
      { id: "r3", title: "Greatest Hits", date: "1999-01-01", "release-group": group("g3", "Album", ["Compilation"]) },
      { id: "r4", title: "A Single", date: "1996-01-01", "release-group": group("g4", "Single") },
      { id: "r5", title: "Untyped", date: "1995-01-01", "release-group": group("g5") },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums.map((a) => a.title)).toEqual(["Studio One"]);
  });

  it("collapses a release group to its earliest release", async () => {
    // One album, four pressings — a discography must show it once, and the
    // original rather than a reissue padded with bonus tracks.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      { id: "reissue", title: "Album (2015 Remaster)", date: "2015-01-01", "release-group": group("g1", "Album") },
      { id: "original", title: "Album", date: "1997-05-21", "release-group": group("g1", "Album") },
      { id: "vinyl", title: "Album (vinyl)", date: "1997-06-01", "release-group": group("g1", "Album") },
      { id: "undated", title: "Album (unknown)", "release-group": group("g1", "Album") },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums).toHaveLength(1);
    expect(albums[0]!.id).toBe("original");
  });

  it("filters server-side so the page budget can cover a real discography", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[]], asked)));
    await api.browseArtistReleases(ARTIST, 25);
    // Without these, a prolific artist's albums sit past the page cap: 1140
    // releases vs 274 official album-type ones, measured against the live API.
    expect(asked[0]).toContain("type=album");
    expect(asked[0]).toContain("status=official");
  });

  it("pages until the artist's releases are exhausted", async () => {
    const asked: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`, title: `Filler ${i}`, date: "1990-01-01", "release-group": group(`gf${i}`, "Single"),
    }));
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([full, [
      { id: "late", title: "Late Album", date: "2016-05-08", "release-group": group("g9", "Album") },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums.map((a) => a.title)).toEqual(["Late Album"]); // found on page 2
    expect(asked).toHaveLength(2);
  });

  it("stops paging on a short page rather than spending the rate-limit budget", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      { id: "r1", title: "Only", date: "2000-01-01", "release-group": group("g1", "Album") },
    ]], asked)));
    await api.browseArtistReleases(ARTIST, 25);
    expect(asked).toHaveLength(1);
  });

  it("returns newest first and honours the limit", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      { id: "a", title: "Old", date: "1990-01-01", "release-group": group("g1", "Album") },
      { id: "b", title: "New", date: "2010-01-01", "release-group": group("g2", "Album") },
      { id: "c", title: "Mid", date: "2000-01-01", "release-group": group("g3", "Album") },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 2);
    expect(albums.map((a) => a.title)).toEqual(["New", "Mid"]);
  });
});
