/**
 * MusicBrainz client, behind an interface so the catalog/meta handlers are
 * testable without network. Returns plain domain shapes (already artist-credit
 * flattened, durations in ms); the handlers turn these into protocol entities
 * with entity-typed ids.
 */

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

export class MusicBrainzApi implements MusicBrainzClient {
  constructor(
    private readonly userAgent: string,
    private readonly baseUrl = "https://musicbrainz.org/ws/2",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async get<T>(path: string, signal?: AbortSignal): Promise<T | undefined> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`MusicBrainz ${path} failed: ${res.status}`);
    return (await res.json()) as T;
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
