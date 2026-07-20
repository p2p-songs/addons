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
  /** 1-based disc (medium) number. */
  disc: number;
  /** Display position — may be free text (vinyl "A4"). */
  position: string;
  durationMs?: number;
}
export interface MbReleaseDetail extends MbRelease {
  tracks: MbTrack[];
}

export interface MusicBrainzClient {
  searchArtists(query: string, limit: number, signal?: AbortSignal): Promise<MbArtist[]>;
  searchReleases(query: string, limit: number, signal?: AbortSignal): Promise<MbRelease[]>;
  searchRecordings(query: string, limit: number, signal?: AbortSignal): Promise<MbRecording[]>;
  getArtist(uuid: string, signal?: AbortSignal): Promise<MbArtist | undefined>;
  getRelease(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined>;
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

  async searchReleases(query: string, limit: number, signal?: AbortSignal): Promise<MbRelease[]> {
    const body = await this.get<{ releases?: RawRelease[] }>(
      `/release?query=${encodeURIComponent(query)}&fmt=json&limit=${limit}`,
      signal,
    );
    return (body?.releases ?? []).map(toRelease);
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
      `/release/${uuid}?fmt=json&inc=recordings+artist-credits+media`,
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
        const durationMs = t.length ?? t.recording.length;
        if (typeof durationMs === "number") track.durationMs = durationMs;
        tracks.push(track);
      }
    });
    return { ...toRelease(r), tracks };
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
  name: string;
  joinphrase?: string;
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
  media?: { position?: number; tracks?: RawTrack[] }[];
}
interface RawTrack {
  id: string;
  number?: string;
  position?: number;
  title?: string;
  length?: number;
  recording?: { id: string; title?: string; length?: number };
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
