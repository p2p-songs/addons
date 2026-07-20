/**
 * Resolution pipeline: `mbid:recording:<uuid>` → ranked, playable `Stream[]`.
 *
 *   1. look the recording up → "Artist – Title" (+ duration)
 *   2. search every registered legal source in parallel (failures isolated)
 *   3. rank/dedupe candidates against the intended recording
 *   4. map to protocol stream objects (https direct urls only)
 */
import type { RecordingId, Stream } from "@p2p-songs/addon-sdk";
import type { MetadataLookup } from "./metadata.js";
import type { Candidate, LegalSource, TrackQuery } from "./sources/types.js";
import { rankCandidates } from "./match.js";
import { licenseLabel } from "./license.js";

export interface ResolveDeps {
  metadata: MetadataLookup;
  /** The fixed allowlist of sources to search. */
  sources: LegalSource[];
  /** Cap on returned streams (default 8). */
  maxResults?: number;
}

export interface ResolveResult {
  streams: Stream[];
  /**
   * True when there was ≥1 source and **every** one failed — a real upstream
   * outage, distinct from a genuine no-match. The handler turns this into a
   * retryable error rather than a long-lived cached empty result (audit A-006).
   */
  allSourcesFailed: boolean;
}

export async function resolveStreams(
  recordingId: RecordingId,
  deps: ResolveDeps,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  // A metadata-lookup failure (e.g. MusicBrainz outage) throws out of here — the
  // handler surfaces it as a retryable error, not an empty success.
  const meta = await deps.metadata.lookup(recordingId, signal);
  if (!meta || !meta.title) return { streams: [], allSourcesFailed: false };

  const query: TrackQuery = { artist: meta.artist, title: meta.title, ...(meta.durationMs ? { durationMs: meta.durationMs } : {}) };

  // Isolate per-source failures — one dead catalog must not sink the response —
  // but remember them, so a *total* outage isn't mistaken for "no matches".
  const settled = await Promise.allSettled(deps.sources.map((s) => s.search(query, signal)));
  const candidates: Candidate[] = [];
  let failures = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") candidates.push(...r.value);
    else failures++;
  }
  const allSourcesFailed = deps.sources.length > 0 && failures === deps.sources.length;

  const ranked = rankCandidates(query, candidates).slice(0, deps.maxResults ?? 8);
  return { streams: ranked.map((c) => toStream(c)), allSourcesFailed };
}

function toStream(c: Candidate): Stream {
  const parts = [c.source === "internet-archive" ? "Internet Archive" : c.source];
  if (c.format) parts.push(c.format);
  if (c.license) parts.push(licenseLabel(c.license));
  const filename = `${c.artist} - ${c.title}${extForFormat(c.format)}`.trim();
  return {
    url: c.url,
    name: parts.join(" · "),
    description: `${c.artist} — ${c.title}`,
    behaviorHints: { filename },
  };
}

function extForFormat(format: string | undefined): string {
  switch (format?.toUpperCase()) {
    case "MP3":
      return ".mp3";
    case "FLAC":
      return ".flac";
    case "OGG":
    case "VORBIS":
      return ".ogg";
    default:
      return "";
  }
}
