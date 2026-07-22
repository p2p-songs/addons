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

describe("searchReleases (album search)", () => {
  const searchFetch = (releases: unknown[], asked: string[]): typeof fetch =>
    (async (input: string | URL) => {
      asked.push(typeof input === "string" ? input : input.toString());
      return new Response(JSON.stringify({ releases }), { status: 200 });
    }) as typeof fetch;

  it("returns one row per album, using the canonically named pressing", async () => {
    // Unfiltered, an album search is the same title repeated once per pressing,
    // and whichever pressing happens to sort first — possibly a localized one.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(searchFetch([
      {
        id: "taiwan", title: "SOUR", date: "2021",
        "artist-credit": [{ name: "奧莉維亞", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { id: "g1", title: "SOUR" },
      },
      {
        id: "worldwide", title: "SOUR", date: "2021-05-21",
        "artist-credit": [{ name: "Olivia Rodrigo", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { id: "g1", title: "SOUR" },
      },
      {
        id: "guts", title: "GUTS", date: "2023-09-08",
        "artist-credit": [{ name: "Olivia Rodrigo", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { id: "g2", title: "GUTS" },
      },
    ], asked)));

    const albums = await api.searchReleases("olivia rodrigo", 25);
    expect(albums.map((a) => a.id)).toEqual(["worldwide", "guts"]); // relevance order kept
    expect(albums[0]!.artist).toBe("Olivia Rodrigo");
  });

  it("over-fetches so collapsing still fills the requested count, within MusicBrainz's cap", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(searchFetch([], asked)));
    await api.searchReleases("q", 10);
    expect(asked[0]).toContain("limit=40");
    await api.searchReleases("q", 50);
    expect(asked[1]).toContain("limit=100");
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

  it("prefers the pressing that uses the album's and artist's canonical names", async () => {
    // The live failure: MusicBrainz's SOUR has 53 pressings, and we showed the
    // Taiwanese one — track titles annotated in Han script, artist credited as
    // 奧莉維亞. Nothing downstream can search for that.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      {
        id: "taiwan", title: "SOUR", date: "2021",
        "artist-credit": [{ name: "奧莉維亞", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { ...group("g1", "Album"), title: "SOUR" },
      },
      {
        id: "japan", title: "サワー", date: "2021-06-02",
        "artist-credit": [{ name: "オリヴィア・ロドリゴ", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { ...group("g1", "Album"), title: "SOUR" },
      },
      {
        id: "worldwide", title: "SOUR", date: "2021-05-21",
        "artist-credit": [{ name: "Olivia Rodrigo", artist: { id: "a1", name: "Olivia Rodrigo" } }],
        "release-group": { ...group("g1", "Album"), title: "SOUR" },
      },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums).toHaveLength(1);
    expect(albums[0]).toMatchObject({ id: "worldwide", title: "SOUR", artist: "Olivia Rodrigo" });
  });

  it("does not privilege Latin script: an artist with non-Latin names keeps their own", async () => {
    // The rule is "agrees with its own group title and artist name", not "looks
    // English" — so a Japanese artist's Japanese pressing is the canonical one.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      {
        id: "export", title: "Solid State Survivor", date: "1979-09-25",
        "artist-credit": [{ name: "Yellow Magic Orchestra", artist: { id: "a2", name: "イエロー・マジック・オーケストラ" } }],
        "release-group": { ...group("g1", "Album"), title: "ソリッド・ステイト・サヴァイヴァー" },
      },
      {
        id: "domestic", title: "ソリッド・ステイト・サヴァイヴァー", date: "1979-09-25",
        "artist-credit": [{ name: "イエロー・マジック・オーケストラ", artist: { id: "a2", name: "イエロー・マジック・オーケストラ" } }],
        "release-group": { ...group("g1", "Album"), title: "ソリッド・ステイト・サヴァイヴァー" },
      },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums[0]!.id).toBe("domestic");
  });

  it("treats a vague date as vague, not early", async () => {
    // `"2021" < "2021-05-21"` as plain strings, which let a year-only pressing
    // pose as the original. Precision is not evidence of age.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      { id: "year-only", title: "Album", date: "2021", "release-group": group("g1", "Album") },
      { id: "exact", title: "Album", date: "2021-05-21", "release-group": group("g1", "Album") },
    ]], asked)));

    const albums = await api.browseArtistReleases(ARTIST, 25);
    expect(albums[0]!.id).toBe("exact");
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
