/**
 * File selection — the music-specific step Torrentio doesn't have (Plan §2a).
 *
 * A movie torrent is effectively one file, so Torrentio takes the largest. A
 * **music torrent is a whole album**: one infohash, many similarly-sized track
 * files across one or more discs. "Largest file" is meaningless here — it would
 * just pick the longest song. Bitbop must pick the *right track file*.
 *
 * Two strategies, in order of trust (Plan §2a):
 *
 *  1. **Deterministic — disc + position.** When the request carried album
 *     context, we know this is disc D, track N. We find the audio file that sits
 *     at position N on disc D by reading the track number encoded in filenames
 *     ("03 - …", "1-03 …", "Disc 2/04 …"). This is exact and is why `mbid:track:`
 *     is worth threading through the whole request.
 *  2. **Fuzzy — title + duration.** With no album context (e.g. a radio pick
 *     from a bare recording), score each audio file's name against the track
 *     title, using file size as a weak duration proxy, and take the best if it
 *     clears a threshold.
 *
 * Non-audio entries (art, logs, cue sheets, nfo) are filtered before either
 * strategy runs. Pure and heavily tested — this is the correctness-critical
 * heart of the addon.
 *
 * **Format preference is part of picking the right file, not a later ranking
 * step.** Music torrents routinely ship the same album several times over —
 * FLAC *and* MP3 *and* WAV of every track. Those files are all equally good
 * matches for "track 3", so whichever strategy runs has to break the tie with
 * the user's `preferFormats`. It cannot be deferred to stream ranking, which
 * only ever sees one already-chosen file per torrent. Note that falling back to
 * "largest" here is actively wrong: WAV is uncompressed, so it beats the FLAC
 * every time.
 */
import type { DebridFile } from "./debrid/types.js";
import type { TrackContext } from "./metadata.js";
import { isAudioFile, extensionOf, formatOfFile, formatPreferenceRank } from "./format.js";

export interface FileMatch {
  file: DebridFile;
  /** How the choice was made — surfaced in the stream label so it's honest about certainty. */
  strategy: "disc-position" | "fuzzy";
  /** 0..1 confidence, for ranking across candidate torrents. */
  confidence: number;
}

/** Below this fuzzy score, we'd rather emit nothing than a probably-wrong track. */
export const FUZZY_THRESHOLD = 0.45;

/**
 * Pick the file for `track` from a torrent's `files`, or `undefined` if no file
 * is a confident match.
 */
export function pickFile(
  files: DebridFile[],
  track: TrackContext,
  /** The user's `preferFormats`, used to break ties between encodings of the same track. */
  preferFormats: readonly string[] = [],
): FileMatch | undefined {
  const audio = files.filter((f) => isAudioFile(f.path));
  if (audio.length === 0) return undefined;

  if (track.hasAlbumContext && track.position !== undefined) {
    const exact = byDiscPosition(audio, track, preferFormats);
    if (exact) return { file: exact, strategy: "disc-position", confidence: 0.95 };
    // Album context but the filenames don't expose track numbers — fall back to
    // fuzzy rather than guess a position.
  }

  return byFuzzyTitle(audio, track, preferFormats);
}

/**
 * Order two equally-good candidates: preferred format first, then larger file.
 * Size is only ever a last resort — within one format it's a decent proxy for
 * bitrate, but across formats it just favours whatever is least compressed.
 */
function preferBetter(a: DebridFile, b: DebridFile, preferFormats: readonly string[]): number {
  const rank =
    formatPreferenceRank(formatOfFile(b.path), preferFormats) -
    formatPreferenceRank(formatOfFile(a.path), preferFormats);
  return rank !== 0 ? rank : (b.sizeBytes ?? 0) - (a.sizeBytes ?? 0);
}

// --- strategy 1: disc + position ---

/** The track number from album context (vinyl "A4" → 4; "03" → 3). */
function targetNumber(position: string): number | undefined {
  const m = /(\d+)/.exec(position);
  return m ? Number(m[1]) : undefined;
}

function byDiscPosition(
  audio: DebridFile[],
  track: TrackContext,
  preferFormats: readonly string[],
): DebridFile | undefined {
  const wantTrack = targetNumber(track.position!);
  if (wantTrack === undefined) return undefined;
  const wantDisc = track.disc;

  const matches = audio.filter((f) => {
    const parsed = parseFileNumbering(f.path);
    if (parsed.track !== wantTrack) return false;
    // If the filename names a disc, it must match; if it doesn't (single-disc
    // rips rarely do), accept only when we're looking for disc 1 or disc is unknown.
    if (parsed.disc !== undefined && wantDisc !== undefined) return parsed.disc === wantDisc;
    if (parsed.disc !== undefined && wantDisc === undefined) return true;
    return wantDisc === undefined || wantDisc === 1 || audioDiscCount(audio) <= 1;
  });

  if (matches.length === 1) return matches[0];
  // Multiple files claim the same track number — usually the same track in
  // several encodings, sometimes a bonus/alt take. Prefer the one whose folder
  // names the right disc, then the user's preferred format.
  if (matches.length > 1) {
    const byDisc = matches.filter((f) => folderNamesDisc(f.path, wantDisc));
    const pool = byDisc.length > 0 ? byDisc : matches;
    return [...pool].sort((a, b) => preferBetter(a, b, preferFormats))[0];
  }
  return undefined;
}

/** How many distinct discs the file numbering exposes (1 when none do). */
function audioDiscCount(audio: DebridFile[]): number {
  const discs = new Set<number>();
  for (const f of audio) {
    const d = parseFileNumbering(f.path).disc;
    if (d !== undefined) discs.add(d);
  }
  return Math.max(1, discs.size);
}

/**
 * Extract disc/track numbers from a file path. Handles the common rip layouts:
 *   "03 - Title.flac"          → { track: 3 }
 *   "1-03 Title.flac"          → { disc: 1, track: 3 }
 *   "Disc 2/04 - Title.flac"   → { disc: 2, track: 4 }
 *   "CD1/A2. Title.mp3"        → { disc: 1, track: 2 }
 */
export function parseFileNumbering(path: string): { disc?: number; track?: number } {
  const segments = path.split("/");
  const filename = segments[segments.length - 1] ?? path;
  const folder = segments.slice(0, -1).join("/");

  let disc: number | undefined;
  const folderDisc = /(?:disc|disk|cd)\s*0*(\d+)/i.exec(folder);
  if (folderDisc) disc = Number(folderDisc[1]);

  // Leading "D-TT" or "D.TT" or "DxTT" disc-track pair on the filename.
  const discTrack = /^\s*(\d{1,2})[\-.x](\d{1,2})\b/.exec(filename);
  if (discTrack) {
    return { disc: disc ?? Number(discTrack[1]), track: Number(discTrack[2]) };
  }

  // Otherwise the leading number is the track (optionally a vinyl side letter).
  const trackOnly = /^\s*(?:[a-d])?0*(\d{1,3})\b/i.exec(filename);
  const result: { disc?: number; track?: number } = {};
  if (disc !== undefined) result.disc = disc;
  if (trackOnly) result.track = Number(trackOnly[1]);
  return result;
}

function folderNamesDisc(path: string, disc: number | undefined): boolean {
  if (disc === undefined) return false;
  const folder = path.split("/").slice(0, -1).join("/");
  const m = /(?:disc|disk|cd)\s*0*(\d+)/i.exec(folder);
  return m ? Number(m[1]) === disc : false;
}

// --- strategy 2: fuzzy title ---

function byFuzzyTitle(
  audio: DebridFile[],
  track: TrackContext,
  preferFormats: readonly string[],
): FileMatch | undefined {
  const scored = audio
    .map((file) => ({ file, score: fuzzyScore(basename(file.path), track.title) }))
    // Title agreement dominates: a better-matching MP3 still beats a FLAC of the
    // wrong song. Format only decides between files that match equally well —
    // which, for an album shipped in several encodings, is every one of them.
    .sort((a, b) => b.score - a.score || preferBetter(a.file, b.file, preferFormats));
  const best = scored[0];
  if (!best || best.score < FUZZY_THRESHOLD) return undefined;
  return { file: best.file, strategy: "fuzzy", confidence: Math.min(0.9, best.score) };
}

function basename(path: string): string {
  const file = path.split("/").pop() ?? path;
  const ext = extensionOf(file);
  const noExt = ext ? file.slice(0, -(ext.length + 1)) : file;
  // Drop a leading track number so it doesn't drown out the title tokens.
  return noExt.replace(/^\s*(?:\d{1,2}[\-.x])?[a-d]?0*\d{1,3}[\s.\-_]+/i, "");
}

/** Lowercase, strip diacritics/punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

/** Token-overlap score of a filename against the track title, 0..1. */
export function fuzzyScore(filename: string, title: string): number {
  const nf = normalize(filename);
  const nt = normalize(title);
  if (!nf || !nt) return 0;
  if (nf === nt) return 1;
  if (nf.includes(nt)) return 0.9; // filename contains the whole title
  const a = tokens(filename);
  const b = tokens(title);
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of b) if (a.has(t)) inter++;
  // Recall against the title tokens matters more than precision (filenames carry
  // extra noise: artist, year, format), so weight the title-side coverage.
  return inter / b.size;
}
