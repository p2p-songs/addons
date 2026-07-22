/**
 * Shared MusicBrainz client. Returns flattened domain shapes (artist-credit
 * joined, durations in ms) so addon handlers can turn them into protocol
 * entities. Every request goes through a {@link RateLimiter} (default 1/sec) and
 * honors `503 Retry-After` — the operational contract the live API requires.
 *
 * Co-host both addons in one process and pass a **shared** limiter to enforce
 * the per-IP budget across them; separate processes each get their own budget
 * (use an external gateway or a MusicBrainz mirror for real multi-process scale).
 */
import { RateLimiter, type Sleep } from "./rate-limit.js";

export interface MbArtist {
  id: string;
  name: string;
}
export interface MbRelease {
  id: string;
  title: string;
  artist: string;
  date?: string;
}
export interface MbRecording {
  id: string;
  title: string;
  artist: string;
  durationMs?: number;
}
export interface MbTrack {
  /** MusicBrainz track id (release+medium scoped). */
  trackId: string;
  /** MusicBrainz recording id (the streamable identity). */
  recordingId: string;
  title: string;
  /**
   * The credited artist for *this track*, when the release states one.
   *
   * On a normal album this repeats the release artist and is redundant. On a
   * **compilation** it is the only useful artist name there is: the release is
   * credited to "Various Artists", which is meaningless to search for.
   */
  artist?: string;
  /** 1-based disc (medium) number. */
  disc: number;
  /** Display position — may be free text (vinyl "A4"). */
  position: string;
  durationMs?: number;
}
export interface MbReleaseDetail extends MbRelease {
  tracks: MbTrack[];
  /** The album this pressing belongs to. */
  releaseGroupId?: string;
  /** The album's first release date — how a later edition is told from the original. */
  groupFirstReleaseDate?: string;
}
/**
 * One album in an artist's discography: a release *group*, plus the one
 * pressing we picked to stand for it.
 */
export interface MbAlbum {
  /** The representative release — the album's identity in our id namespace. */
  id: string;
  /** The release group. Cover art is far better covered per group than per pressing. */
  releaseGroupId: string;
  title: string;
  artist: string;
  /** The group's first release date — the album's date, not this pressing's. */
  date?: string;
}

export interface MusicBrainzClient {
  searchArtists(query: string, limit: number, signal?: AbortSignal): Promise<MbArtist[]>;
  searchReleases(query: string, limit: number, signal?: AbortSignal): Promise<MbRelease[]>;
  searchRecordings(query: string, limit: number, signal?: AbortSignal): Promise<MbRecording[]>;
  /** An artist's studio albums, newest first (see the implementation). */
  artistDiscography(artistUuid: string, limit: number, signal?: AbortSignal): Promise<MbAlbum[]>;
  getArtist(uuid: string, signal?: AbortSignal): Promise<MbArtist | undefined>;
  /** Exactly the release asked for. */
  getRelease(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined>;
  /** The album as first released — see the implementation. */
  getAlbum(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined>;
  getRecording(uuid: string, signal?: AbortSignal): Promise<MbRecording | undefined>;
}

export interface MusicBrainzApiOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Shared limiter — pass the same instance to co-hosted addons. Defaults to 1/sec. */
  limiter?: RateLimiter;
  /** Max 503 retries (default 2). */
  maxRetries?: number;
  sleep?: Sleep;
}

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class MusicBrainzApi implements MusicBrainzClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly limiter: RateLimiter;
  private readonly maxRetries: number;
  private readonly sleep: Sleep;

  constructor(
    private readonly userAgent: string,
    options: MusicBrainzApiOptions = {},
  ) {
    this.baseUrl = options.baseUrl ?? "https://musicbrainz.org/ws/2";
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.limiter = options.limiter ?? new RateLimiter(1000, options.sleep);
    this.maxRetries = options.maxRetries ?? 2;
    this.sleep = options.sleep ?? realSleep;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
    const url = `${this.baseUrl}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.limiter.run(() =>
        this.fetchImpl(url, {
          headers: { "User-Agent": this.userAgent, Accept: "application/json" },
          ...(signal ? { signal } : {}),
        }),
      );
      if (res.status === 503 && attempt < this.maxRetries) {
        await this.sleep(retryAfterMs(res));
        continue;
      }
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`MusicBrainz ${path} failed: ${res.status}`);
      return (await res.json()) as T;
    }
  }

  async searchArtists(query: string, limit: number, signal?: AbortSignal): Promise<MbArtist[]> {
    const body = await this.get<{ artists?: RawArtist[] }>(
      `/artist?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
      signal,
    );
    return (body?.artists ?? []).map((a) => ({ id: a.id, name: a.name }));
  }

  /**
   * Album search, collapsed to one release per album.
   *
   * Raw release search is unusable as an album list: a popular album has dozens
   * of pressings, all matching equally, so the results are the same title over
   * and over — and which pressing surfaces first is arbitrary, so it may well be
   * a regional one titled in another script. Both problems are the same problem,
   * and {@link betterRepresentative} is the same answer as in the discography.
   *
   * We over-fetch to give the collapse headroom (25 requested albums can easily
   * be 100 releases) and keep MusicBrainz's relevance order for the groups
   * themselves — relevance is the whole point of a search, unlike a discography.
   */
  async searchReleases(query: string, limit: number, signal?: AbortSignal): Promise<MbRelease[]> {
    const fetchLimit = Math.min(limit * SEARCH_OVERFETCH, SEARCH_MAX_LIMIT);
    const body = await this.get<{ releases?: RawRelease[] }>(
      `/release?query=${encodeURIComponent(query)}&fmt=json&limit=${fetchLimit}`,
      signal,
    );
    const byGroup = new Map<string, RawRelease>();
    for (const r of body?.releases ?? []) {
      const groupId = r["release-group"]?.id ?? r.id;
      const seen = byGroup.get(groupId);
      if (!seen || betterRepresentative(r, seen)) byGroup.set(groupId, r);
    }
    return [...byGroup.values()].slice(0, limit).map(toRelease);
  }

  /**
   * An artist's discography: their **studio albums**, newest first.
   *
   * This asks for release *groups* — the album — rather than releases, and it
   * uses `search` rather than `browse`, both for the same reason: cost. Three
   * measurements against the live API decided it:
   *
   * 1. **Browsing releases cannot be bounded.** An album has one release group
   *    but dozens of pressings, so a discography browsed as releases is mostly
   *    duplicates: Taylor Swift has 981 official album releases across 10 pages
   *    of 100. Worse, they come back in date order, so the newest albums are on
   *    the *last* page — a 3-page cap returned 6 of her 18 albums and silently
   *    hid everything after 2017. Nothing short of paging all 10 fixes that,
   *    and Elvis Presley and Miles Davis need 16.
   * 2. **Browse cannot filter secondary types, and search can.** `type=album`
   *    still admits live records, compilations and bootlegs — that is how
   *    browsing Radiohead produced 25 rows with zero studio albums — and there
   *    is no browse parameter to exclude them, which leaves Elvis at 1057 album
   *    groups. The Lucene term `-secondarytype:*` does it server-side, and the
   *    same three artists collapse to **18, 47 and 10 groups: one page each**.
   * 3. **Release-group search results embed their releases**, so the one
   *    request also yields the release id we need for the album's identity.
   *    (`inc=releases` is rejected on release-group *browse* — 400 — which is
   *    the other half of why this is a search.)
   *
   * So: one request per artist, complete, and no arbitrary cutoff.
   */
  async artistDiscography(artistUuid: string, limit: number, signal?: AbortSignal): Promise<MbAlbum[]> {
    const query = `arid:${artistUuid} AND primarytype:album AND -secondarytype:*`;
    const albums: MbAlbum[] = [];
    for (let page = 0; page < MAX_DISCOGRAPHY_PAGES; page++) {
      const body = await this.get<{ "release-groups"?: RawSearchReleaseGroup[]; count?: number }>(
        `/release-group?query=${encodeURIComponent(query)}&fmt=json` +
          `&limit=${SEARCH_MAX_LIMIT}&offset=${page * SEARCH_MAX_LIMIT}`,
        signal,
      );
      const groups = body?.["release-groups"] ?? [];
      for (const group of groups) {
        const release = representativeRelease(group);
        // No official release means nothing playable to point an id at — this
        // is what drops the bootleg-only groups ("The Vault (deluxe)").
        if (!release) continue;
        const album: MbAlbum = {
          id: release,
          releaseGroupId: group.id,
          title: group.title,
          artist: creditToName(group["artist-credit"]),
        };
        const date = group["first-release-date"];
        if (date) album.date = date;
        albums.push(album);
      }
      const total = body?.count;
      if (groups.length < SEARCH_MAX_LIMIT || (total !== undefined && (page + 1) * SEARCH_MAX_LIMIT >= total)) break;
    }
    return albums
      .sort((a, b) => dateKey(b.date).localeCompare(dateKey(a.date))) // newest album first
      .slice(0, limit);
  }

  async searchRecordings(query: string, limit: number, signal?: AbortSignal): Promise<MbRecording[]> {
    const body = await this.get<{ recordings?: RawRecording[] }>(
      `/recording?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
      signal,
    );
    return (body?.recordings ?? []).map(toRecording);
  }

  async getArtist(uuid: string, signal?: AbortSignal): Promise<MbArtist | undefined> {
    const a = await this.get<RawArtist>(`/artist/${uuid}?fmt=json`, signal);
    return a ? { id: a.id, name: a.name } : undefined;
  }

  async getRelease(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined> {
    const r = await this.get<RawRelease>(
      // `release-groups` is free here and is what lets `getAlbum` tell an
      // original pressing from a later deluxe edition without a second request.
      `/release/${uuid}?fmt=json&inc=recordings+artist-credits+media+release-groups`,
      signal,
    );
    if (!r) return undefined;
    const tracks: MbTrack[] = [];
    (r.media ?? []).forEach((medium, i) => {
      const disc = medium.position ?? i + 1;
      for (const t of medium.tracks ?? []) {
        if (!t.recording?.id) continue;
        const track: MbTrack = {
          trackId: t.id,
          recordingId: t.recording.id,
          title: t.title ?? t.recording.title ?? "",
          disc,
          position: t.number ?? String(t.position ?? ""),
        };
        // Prefer the track-level credit; fall back to the recording's own.
        const artist = creditToName(t["artist-credit"]) || creditToName(t.recording["artist-credit"]);
        if (artist) track.artist = artist;
        const durationMs = t.length ?? t.recording.length;
        if (typeof durationMs === "number") track.durationMs = durationMs;
        tracks.push(track);
      }
    });
    const detail: MbReleaseDetail = { ...toRelease(r), tracks };
    const group = r["release-group"];
    if (group?.id) detail.releaseGroupId = group.id;
    if (group?.["first-release-date"]) detail.groupFirstReleaseDate = group["first-release-date"];
    return detail;
  }

  /**
   * The album as **first released**, given any pressing of it.
   *
   * A release group mixes the original album with its later deluxe, anniversary
   * and expanded editions, and the discography search cannot tell them apart —
   * its embedded releases carry only id, title and status, no date and no track
   * count. So evermore resolved to a 17-track deluxe (2021-01-07) rather than
   * the 15-track original (2020-12-11), and its two bonus tracks were then
   * unplayable: they exist on no ordinary rip, so `pickFile` correctly refused
   * rather than serving the wrong song. Fifteen tracks played, two did not.
   *
   * Choosing the original is the conservative direction. A deluxe edition only
   * ever *appends*, so positions 1..n still line up if the source turns out to
   * be a deluxe rip — the user simply doesn't see bonus tracks. The reverse,
   * which is what we shipped, advertises tracks that usually cannot be found.
   *
   * Costs nothing in the common case: `getRelease` already returns the group's
   * `first-release-date`, so a pressing that matches it is returned as-is.
   */
  async getAlbum(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined> {
    const requested = await this.getRelease(uuid, signal);
    if (!requested) return undefined;
    const groupId = requested.releaseGroupId;
    const originalDate = requested.groupFirstReleaseDate;
    if (!groupId || !originalDate || requested.date === originalDate) return requested;

    const body = await this.get<{ releases?: RawRelease[] }>(
      `/release?release-group=${encodeURIComponent(groupId)}&status=official` +
        `&inc=artist-credits+media+release-groups&fmt=json&limit=${SEARCH_MAX_LIMIT}`,
      signal,
    );
    const originals = (body?.releases ?? []).filter((r) => r.date === originalDate);
    let best = originals[0];
    for (const candidate of originals.slice(1)) {
      if (best && betterEdition(candidate, best)) best = candidate;
    }
    if (!best || best.id === uuid) return requested;
    return this.getRelease(best.id, signal);
  }

  async getRecording(uuid: string, signal?: AbortSignal): Promise<MbRecording | undefined> {
    const r = await this.get<RawRecording>(`/recording/${uuid}?fmt=json&inc=artist-credits`, signal);
    return r ? toRecording(r) : undefined;
  }
}

/** Parse `Retry-After` (seconds); default to 1s. */
function retryAfterMs(res: Response): number {
  const header = res.headers.get("Retry-After");
  const secs = header ? Number(header) : NaN;
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : 1000;
}

// --- raw MusicBrainz JSON → domain shapes ---

interface RawArtistCredit {
  /** The name **as credited on this release** — localized on a regional pressing. */
  name: string;
  joinphrase?: string;
  /** The artist entity itself, whose `name` is canonical. See {@link presentsCanonicalNames}. */
  artist?: { id: string; name: string };
}
interface RawArtist {
  id: string;
  name: string;
}
interface RawRelease {
  id: string;
  title: string;
  date?: string;
  "artist-credit"?: RawArtistCredit[];
  "release-group"?: RawReleaseGroup;
  media?: { position?: number; "track-count"?: number; tracks?: RawTrack[] }[];
}
/** A release-group *search* hit, which — unlike a browse — embeds its releases. */
interface RawSearchReleaseGroup {
  id: string;
  title: string;
  "first-release-date"?: string;
  "artist-credit"?: RawArtistCredit[];
  /** Only `id`/`title`/`status` are populated here; no date, no credit. */
  releases?: { id: string; title: string; status?: string }[];
}

interface RawReleaseGroup {
  id: string;
  /** The album's canonical title, as opposed to this pressing's. */
  title?: string;
  /** The album's original release date, as opposed to this pressing's. */
  "first-release-date"?: string;
  /** "Album" | "Single" | "EP" | "Broadcast" | "Other". */
  "primary-type"?: string;
  /** "Live" | "Compilation" | "Remix" | "DJ-mix" | "Bootleg" | … — any of these disqualifies. */
  "secondary-types"?: string[];
}

/**
 * The pressing that stands for an album in a discography.
 *
 * Release-group search embeds each group's releases, but only their `id`,
 * `title` and `status` — no date and no artist credit, so the full
 * {@link betterRepresentative} comparison can't run here. What survives is the
 * part that matters: **Official** (so a bootleg or a promo never represents the
 * album) and a title equal to the group's, which is both the canonical-naming
 * test and what excludes deluxe/anniversary pressings padded with bonus tracks.
 *
 * Measured across 17 albums from three artists, this picked a canonically named
 * and credited pressing every time. It is a weaker guarantee than
 * `betterRepresentative` gets from full release data, and the residual risk is
 * a pressing that keeps the album's exact title while re-crediting the artist
 * in another script — invisible from here. If that ever shows up, the fix is a
 * corrective lookup in {@link MusicBrainzApi.getRelease}, not more guessing at
 * this level.
 */
function representativeRelease(group: RawSearchReleaseGroup): string | undefined {
  const official = (group.releases ?? []).filter((r) => r.status === "Official");
  if (official.length === 0) return undefined;
  const exact = official.find((r) => normalizeName(r.title) === normalizeName(group.title));
  return (exact ?? official[0])!.id;
}

/**
 * Which of two same-dated original pressings to prefer: canonically named
 * first (the localization rule), then the shortest track list — a pressing
 * padded with bonus material is a worse stand-in for the album than a plain one.
 */
function betterEdition(candidate: RawRelease, incumbent: RawRelease): boolean {
  const c = presentsCanonicalNames(candidate);
  const i = presentsCanonicalNames(incumbent);
  if (c !== i) return c;
  return trackCount(candidate) < trackCount(incumbent);
}

function trackCount(r: RawRelease): number {
  return (r.media ?? []).reduce((n, m) => n + (m["track-count"] ?? 0), 0);
}

/**
 * Which of two pressings should stand for their album.
 *
 * Canonical naming outranks age, because a pressing that renames the album or
 * the artist is unusable downstream no matter how original it is.
 */
function betterRepresentative(candidate: RawRelease, incumbent: RawRelease): boolean {
  const c = presentsCanonicalNames(candidate);
  const i = presentsCanonicalNames(incumbent);
  if (c !== i) return c;
  return dateKey(candidate.date) < dateKey(incumbent.date);
}

/**
 * Does this pressing present the album under its canonical names?
 *
 * A regional pressing may retitle the album and re-credit the artist in the
 * local script. MusicBrainz lists a Taiwanese SOUR credited to 奧莉維亞 and a
 * Japanese one titled サワー — both perfectly legitimate releases, and both
 * useless to us: the localized name is not what the user typed, not what the
 * cover art shows them, and not what any torrent is named, so it silently
 * turns every downstream indexer query into a guaranteed miss.
 *
 * The test needs no locale, country or script list, because MusicBrainz already
 * stores the canonical name beside the localized one: `artist-credit[].artist.name`
 * is the artist's own name next to the as-credited `.name`, and the release
 * *group* carries the album's title next to the release's. So we just ask
 * whether this pressing agrees with them.
 *
 * Explicitly **not** `text-representation.script`, the obvious-looking signal:
 * it is wrong for precisely this case — the Japanese サワー pressing reports
 * `script: "Latn"`.
 *
 * Nothing here privileges Latin script. An artist whose canonical names *are*
 * non-Latin agrees with their own group title and artist name, so their
 * pressings all pass and the choice falls through to date, exactly as before.
 */
function presentsCanonicalNames(r: RawRelease): boolean {
  const groupTitle = r["release-group"]?.title;
  if (groupTitle !== undefined && normalizeName(r.title) !== normalizeName(groupTitle)) return false;
  return (r["artist-credit"] ?? []).every((c) => !c.artist || normalizeName(c.name) === normalizeName(c.artist.name));
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A MusicBrainz date sorted so that "earliest" means what we mean.
 *
 * Dates carry their precision — `2021`, `2021-08` and `2021-05-21` are all
 * valid — and comparing them as plain strings makes the *vaguest* one win,
 * since `"2021" < "2021-05-21"`. That is how a year-only Taiwanese pressing
 * beat the dated original and became the SOUR we showed. Padding an unknown
 * month or day to the end of its period states the actual rule: knowing a date
 * only to the year is not evidence of being earlier than a day inside it.
 *
 * An undated pressing sorts last — a worse "original" than any dated one.
 */
function dateKey(date: string | undefined): string {
  if (!date) return "9999-99-99";
  const [year = "9999", month = "99", day = "99"] = date.split("-");
  return `${year.padStart(4, "0")}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Headroom for collapsing search results to one release per album. Dozens of
 * pressings share an album, so asking for exactly `limit` releases would return
 * far fewer than `limit` albums.
 */
const SEARCH_OVERFETCH = 4;
/** MusicBrainz caps a search page at 100. */
const SEARCH_MAX_LIMIT = 100;
/**
 * Pages of release-group search results to scan for a discography. One page is
 * 100 albums, which covered every artist measured — the most prolific, Elvis
 * Presley, has 47 studio albums. The second page exists so a pathological
 * discography degrades by truncation rather than by silently paging forever;
 * each costs a second of the =<1 req/sec budget.
 */
const MAX_DISCOGRAPHY_PAGES = 2;

interface RawTrack {
  id: string;
  number?: string;
  position?: number;
  title?: string;
  length?: number;
  "artist-credit"?: RawArtistCredit[];
  recording?: { id: string; title?: string; length?: number; "artist-credit"?: RawArtistCredit[] };
}
interface RawRecording {
  id: string;
  title: string;
  length?: number;
  "artist-credit"?: RawArtistCredit[];
}

function creditToName(credit: RawArtistCredit[] | undefined): string {
  return (credit ?? []).map((c) => `${c.name}${c.joinphrase ?? ""}`).join("").trim();
}

function toRelease(r: RawRelease): MbRelease {
  const out: MbRelease = { id: r.id, title: r.title, artist: creditToName(r["artist-credit"]) };
  if (r.date) out.date = r.date;
  return out;
}

function toRecording(r: RawRecording): MbRecording {
  const out: MbRecording = { id: r.id, title: r.title, artist: creditToName(r["artist-credit"]) };
  if (typeof r.length === "number") out.durationMs = r.length;
  return out;
}
