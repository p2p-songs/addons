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

describe("artistDiscography", () => {
  const ARTIST = "cccccccc-cccc-cccc-cccc-cccccccccccc";

  /** A release-group search hit, with its releases embedded as the API sends them. */
  const rg = (
    id: string,
    title: string,
    date: string | undefined,
    releases: { id: string; title?: string; status?: string }[],
  ) => ({
    id,
    title,
    ...(date ? { "first-release-date": date } : {}),
    "artist-credit": [{ name: "Some Artist", artist: { id: "a1", name: "Some Artist" } }],
    releases: releases.map((r) => ({ id: r.id, title: r.title ?? title, ...(r.status ? { status: r.status } : {}) })),
  });

  /** Serve pages of release-group search results, recording the URLs asked for. */
  const pagedFetch = (pages: unknown[][], asked: string[]): typeof fetch =>
    (async (input: string | URL) => {
      const url = typeof input === "string" ? input : input.toString();
      asked.push(url);
      const offset = Number(/offset=(\d+)/.exec(url)?.[1] ?? 0);
      const groups = pages[offset / 100] ?? [];
      return new Response(JSON.stringify({ "release-groups": groups, count: pages.flat().length }), { status: 200 });
    }) as typeof fetch;

  it("asks for studio albums only, server-side", async () => {
    // Browse cannot exclude secondary types, which is why this is a search:
    // `type=album` still admits live records, compilations and bootlegs, and
    // without this term Elvis Presley returns 1057 groups instead of 47.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[]], asked)));
    await api.artistDiscography(ARTIST, 25);
    const query = decodeURIComponent(asked[0]!);
    expect(query).toContain(`arid:${ARTIST}`);
    expect(query).toContain("primarytype:album");
    expect(query).toContain("-secondarytype:*");
  });

  it("returns one row per album, newest first, honouring the limit", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      rg("g1", "Old", "1990-01-01", [{ id: "r1", status: "Official" }]),
      rg("g2", "New", "2010-01-01", [{ id: "r2", status: "Official" }]),
      rg("g3", "Mid", "2000-01-01", [{ id: "r3", status: "Official" }]),
    ]], asked)));

    const albums = await api.artistDiscography(ARTIST, 2);
    expect(albums.map((a) => a.title)).toEqual(["New", "Mid"]);
    expect(albums[0]).toMatchObject({ id: "r2", releaseGroupId: "g2", artist: "Some Artist", date: "2010-01-01" });
  });

  it("represents an album with an official pressing under the album's own title", async () => {
    // Search embeds only id/title/status per release — no date, no credit — so
    // these two facts are the whole basis for the choice. Title equality both
    // rejects bonus-track editions and keeps the canonical name.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      rg("g1", "Midnights", "2022-10-21", [
        { id: "bootleg", title: "Midnights (The Full Moon edition)", status: "Bootleg" },
        { id: "promo", title: "Midnights (McDonalds Deluxe)", status: "Promotion" },
        { id: "deluxe", title: "Midnights (The Late Night Edition)", status: "Official" },
        { id: "plain", title: "Midnights", status: "Official" },
      ]),
    ]], asked)));

    const albums = await api.artistDiscography(ARTIST, 25);
    expect(albums[0]!.id).toBe("plain");
  });

  it("falls back to any official pressing when none matches the album title", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      rg("g1", "Album", "2000-01-01", [
        { id: "bootleg", title: "Album (bootleg)", status: "Bootleg" },
        { id: "reissue", title: "Album (2015 Remaster)", status: "Official" },
      ]),
    ]], asked)));
    expect((await api.artistDiscography(ARTIST, 25))[0]!.id).toBe("reissue");
  });

  it("drops a group with no official release rather than pointing at a bootleg", async () => {
    // Live examples: Taylor Swift's "The Vault (deluxe)" and "Lover The Secret
    // Studio Sessions" are album-typed groups with nothing official behind them.
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      rg("g1", "Real Album", "2000-01-01", [{ id: "r1", status: "Official" }]),
      rg("g2", "The Vault (deluxe)", "2021-03-16", [{ id: "r2", status: "Bootleg" }]),
      rg("g3", "No Releases At All", "1999-01-01", []),
    ]], asked)));

    expect((await api.artistDiscography(ARTIST, 25)).map((a) => a.title)).toEqual(["Real Album"]);
  });

  it("stops paging on a short page rather than spending the rate-limit budget", async () => {
    const asked: string[] = [];
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([[
      rg("g1", "Only", "2000-01-01", [{ id: "r1", status: "Official" }]),
    ]], asked)));
    await api.artistDiscography(ARTIST, 25);
    expect(asked).toHaveLength(1);
  });

  it("pages when an artist has more albums than one page holds", async () => {
    const asked: string[] = [];
    const full = Array.from({ length: 100 }, (_, i) =>
      rg(`gf${i}`, `Filler ${i}`, "1990-01-01", [{ id: `rf${i}`, status: "Official" }]));
    const api = new MusicBrainzApi("test/0.0", opts(pagedFetch([full, [
      rg("g9", "Late Album", "2016-05-08", [{ id: "late", status: "Official" }]),
    ]], asked)));

    const albums = await api.artistDiscography(ARTIST, 25);
    expect(albums[0]!.title).toBe("Late Album"); // newest, found on page 2
    expect(asked).toHaveLength(2);
  });
});
