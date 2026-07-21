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
