/**
 * Jamendo source — a catalog of Creative-Commons-licensed music with a clean
 * API. Requires an operator-set app `client_id` (an application credential, not
 * a per-user secret), so it is only added to the allowlist when configured; the
 * addon stays fully functional without it. Stream URLs come straight from the
 * Jamendo API `audio` field (its own CDN).
 */
import type { Candidate, LegalSource, TrackQuery } from "./types.js";

const API_URL = "https://api.jamendo.com/v3.0/tracks";

export class JamendoSource implements LegalSource {
  readonly id = "jamendo";
  readonly name = "Jamendo";

  constructor(
    private readonly clientId: string,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly limit = 5,
  ) {}

  async search(query: TrackQuery, signal?: AbortSignal): Promise<Candidate[]> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      format: "json",
      limit: String(this.limit),
      namesearch: query.title,
      artist_name: query.artist,
      audioformat: "mp32",
    });
    const res = await this.fetchImpl(`${API_URL}/?${params.toString()}`, signal ? { signal } : {});
    if (!res.ok) throw new Error(`Jamendo search failed: ${res.status}`);
    const body = (await res.json()) as JamendoResponse;

    const out: Candidate[] = [];
    for (const t of body.results ?? []) {
      if (!t.audio) continue;
      const candidate: Candidate = {
        source: this.id,
        title: t.name?.trim() ?? "",
        artist: t.artist_name?.trim() ?? "",
        url: t.audio,
        format: "MP3",
      };
      if (typeof t.duration === "number" && t.duration > 0) candidate.durationMs = t.duration * 1000;
      if (t.license_ccurl) candidate.license = t.license_ccurl;
      out.push(candidate);
    }
    return out;
  }
}

interface JamendoResponse {
  results?: {
    name?: string;
    artist_name?: string;
    audio?: string;
    duration?: number;
    license_ccurl?: string;
  }[];
}
