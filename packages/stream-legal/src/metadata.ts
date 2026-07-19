/**
 * Recording metadata lookup: `mbid:recording:<uuid>` → "Artist – Title" (+
 * duration), which is what the legal sources are actually searched by. This is
 * `stream-legal`'s own discovery step (a stream addon receives only an id and
 * must figure out what to search for — like Torrentio resolving an IMDb id).
 * Behind an interface so the resolver is testable without network.
 */
import { parseMbid, type RecordingId } from "@p2p-songs/addon-sdk";

export interface RecordingMeta {
  artist: string;
  title: string;
  durationMs?: number;
}

export interface MetadataLookup {
  /** Resolve a recording id to metadata, or `undefined` if not found. */
  lookup(recordingId: RecordingId, signal?: AbortSignal): Promise<RecordingMeta | undefined>;
}

/** Default MusicBrainz-backed lookup. */
export class MusicBrainzLookup implements MetadataLookup {
  constructor(
    private readonly userAgent: string,
    private readonly baseUrl = "https://musicbrainz.org/ws/2",
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async lookup(recordingId: RecordingId, signal?: AbortSignal): Promise<RecordingMeta | undefined> {
    const { uuid } = parseMbid(recordingId);
    const url = `${this.baseUrl}/recording/${uuid}?fmt=json&inc=artist-credits`;
    const res = await this.fetchImpl(url, {
      headers: { "User-Agent": this.userAgent, Accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (res.status === 404) return undefined;
    if (!res.ok) throw new Error(`MusicBrainz lookup failed: ${res.status}`);
    const body = (await res.json()) as MusicBrainzRecording;

    const title = body.title?.trim();
    if (!title) return undefined;
    const artist = (body["artist-credit"] ?? [])
      .map((c) => `${c.name}${c.joinphrase ?? ""}`)
      .join("")
      .trim();
    const meta: RecordingMeta = { artist, title };
    if (typeof body.length === "number" && body.length > 0) meta.durationMs = body.length;
    return meta;
  }
}

interface MusicBrainzRecording {
  title?: string;
  /** Track length in milliseconds. */
  length?: number;
  "artist-credit"?: { name: string; joinphrase?: string }[];
}
