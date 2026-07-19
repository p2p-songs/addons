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

export interface ResolveDeps {
  metadata: MetadataLookup;
  /** The fixed allowlist of sources to search. */
  sources: LegalSource[];
  /** Cap on returned streams (default 8). */
  maxResults?: number;
}

export async function resolveStreams(
  recordingId: RecordingId,
  deps: ResolveDeps,
  signal?: AbortSignal,
): Promise<Stream[]> {
  const meta = await deps.metadata.lookup(recordingId, signal);
  if (!meta || !meta.title) return [];

  const query: TrackQuery = { artist: meta.artist, title: meta.title, ...(meta.durationMs ? { durationMs: meta.durationMs } : {}) };

  // Isolate per-source failures — one dead catalog must not sink the response.
  const settled = await Promise.allSettled(deps.sources.map((s) => s.search(query, signal)));
  const candidates: Candidate[] = [];
  for (const r of settled) if (r.status === "fulfilled") candidates.push(...r.value);

  const ranked = rankCandidates(query, candidates).slice(0, deps.maxResults ?? 8);
  return ranked.map((c) => toStream(c));
}

function toStream(c: Candidate): Stream {
  const parts = [c.source === "internet-archive" ? "Internet Archive" : c.source];
  if (c.format) parts.push(c.format);
  if (c.license) parts.push(c.license);
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
