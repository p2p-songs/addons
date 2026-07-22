/**
 * Audio-format detection and normalization, shared by discovery (label a
 * torrent), file selection (score by extension), and ranking (honor the user's
 * `preferFormats`). Pure and tested.
 */

/** Canonical labels we normalize to. Order is quality-descending for tie-breaks. */
export const KNOWN_FORMATS = ["FLAC", "ALAC", "WAV", "AIFF", "M4A", "OGG", "OPUS", "MP3", "AAC", "WMA"] as const;
export type AudioFormat = (typeof KNOWN_FORMATS)[number];

const EXT_TO_FORMAT: Record<string, AudioFormat> = {
  flac: "FLAC",
  alac: "ALAC",
  wav: "WAV",
  aif: "AIFF",
  aiff: "AIFF",
  m4a: "M4A",
  ogg: "OGG",
  oga: "OGG",
  opus: "OPUS",
  mp3: "MP3",
  aac: "AAC",
  wma: "WMA",
};

/** Audio file extensions, for telling a track file apart from cover art / logs / cue sheets. */
export const AUDIO_EXTENSIONS = new Set(Object.keys(EXT_TO_FORMAT));

/** Detect a display format from a release title or filename, or `undefined`. */
export function detectFormat(text: string): AudioFormat | undefined {
  const lower = text.toLowerCase();
  // Prefer an explicit file extension at the end of a filename.
  const extMatch = /\.([a-z0-9]{2,4})$/.exec(lower);
  if (extMatch && EXT_TO_FORMAT[extMatch[1]!]) return EXT_TO_FORMAT[extMatch[1]!];
  // Otherwise look for a format word anywhere in the title (release tags).
  for (const fmt of KNOWN_FORMATS) {
    if (new RegExp(`\\b${fmt}\\b`, "i").test(lower)) return fmt;
  }
  return undefined;
}

/** The file extension (without dot), lowercased, or `undefined`. */
export function extensionOf(path: string): string | undefined {
  const m = /\.([a-z0-9]{2,4})$/i.exec(path);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** Is this path an audio file we could stream (as opposed to art, cue, log, nfo)? */
export function isAudioFile(path: string): boolean {
  const ext = extensionOf(path);
  return ext !== undefined && AUDIO_EXTENSIONS.has(ext);
}

/**
 * The format of an audio *file*, from its extension alone.
 *
 * Deliberately narrower than {@link detectFormat}: that one falls back to
 * scanning for a format word anywhere in the text, which is right for a release
 * *title* but wrong for a path — a file inside a folder named `Album [FLAC]`
 * would report FLAC whatever it actually is.
 */
export function formatOfFile(path: string): AudioFormat | undefined {
  const ext = extensionOf(path);
  return ext ? EXT_TO_FORMAT[ext] : undefined;
}

/**
 * Rank a format against the user's `preferFormats`, higher being better.
 * Unlisted formats rank below every listed one but are never excluded, and an
 * unrecognized file ranks below those — same semantics the stream ranking uses.
 */
export function formatPreferenceRank(format: AudioFormat | undefined, preferFormats: readonly string[]): number {
  if (!format) return -1;
  const idx = preferFormats.findIndex((f) => f.toUpperCase() === format.toUpperCase());
  return idx < 0 ? 0 : preferFormats.length - idx;
}
