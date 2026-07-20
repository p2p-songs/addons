/**
 * Internet Archive source — open, key-less, hosts a large public-domain / CC
 * audio collection. Two steps: advanced search for matching audio items, then
 * that item's file list → direct `https://archive.org/download/...` URLs.
 *
 * URLs are always built from the item identifier + file name returned by the
 * IA API — never from caller input — so this cannot be turned into an open
 * proxy (Review Checklist §5).
 */
import type { Candidate, LegalSource, TrackQuery } from "./types.js";
import { isRecognizedOpenLicense } from "../license.js";

const SEARCH_URL = "https://archive.org/advancedsearch.php";
const METADATA_URL = "https://archive.org/metadata";
const DOWNLOAD_URL = "https://archive.org/download";

const AUDIO_FORMATS = new Map<string, string>([
  ["vbr mp3", "MP3"],
  ["mp3", "MP3"],
  ["128kbps mp3", "MP3"],
  ["flac", "FLAC"],
  ["ogg vorbis", "OGG"],
]);

export class InternetArchiveSource implements LegalSource {
  readonly id = "internet-archive";
  readonly name = "Internet Archive";

  constructor(
    private readonly fetchImpl: typeof fetch = fetch,
    /** Max items to expand into file lists per search. */
    private readonly maxItems = 4,
  ) {}

  async search(query: TrackQuery, signal?: AbortSignal): Promise<Candidate[]> {
    const q = `title:(${quote(query.title)}) AND creator:(${quote(query.artist)}) AND mediatype:(audio)`;
    const url =
      `${SEARCH_URL}?q=${encodeURIComponent(q)}` +
      `&fl[]=identifier&fl[]=title&fl[]=creator&fl[]=licenseurl&rows=${this.maxItems}&output=json`;

    const res = await this.fetchImpl(url, signal ? { signal } : {});
    if (!res.ok) throw new Error(`Internet Archive search failed: ${res.status}`);
    const body = (await res.json()) as IaSearch;
    const docs = body.response?.docs ?? [];

    const perItem = await Promise.allSettled(docs.map((d) => this.filesFor(d, signal)));
    const out: Candidate[] = [];
    for (const r of perItem) if (r.status === "fulfilled") out.push(...r.value);
    return out;
  }

  private async filesFor(doc: IaDoc, signal?: AbortSignal): Promise<Candidate[]> {
    const res = await this.fetchImpl(`${METADATA_URL}/${encodeURIComponent(doc.identifier)}`, signal ? { signal } : {});
    if (!res.ok) return [];
    const meta = (await res.json()) as IaMetadata;
    const artist = firstString(doc.creator) ?? firstString(meta.metadata?.creator) ?? "";
    const license = doc.licenseurl ?? meta.metadata?.licenseurl;

    // Fail closed per item: emit nothing unless the item carries a recognized
    // open (CC / public-domain) license. Archive hosting alone is not evidence
    // of open rights (audit A-006).
    if (!isRecognizedOpenLicense(license)) return [];

    const out: Candidate[] = [];
    for (const f of meta.files ?? []) {
      const format = f.format ? AUDIO_FORMATS.get(f.format.toLowerCase()) : undefined;
      if (!format || !f.name) continue;
      const candidate: Candidate = {
        source: this.id,
        title: f.title?.trim() || doc.title?.trim() || f.name,
        artist,
        url: `${DOWNLOAD_URL}/${encodeURIComponent(doc.identifier)}/${encodeURIComponent(f.name)}`,
        format,
        license: license!,
      };
      const durationMs = parseLengthMs(f.length);
      if (durationMs !== undefined) candidate.durationMs = durationMs;
      out.push(candidate);
    }
    return out;
  }
}

/** Escape a phrase for the IA query language. */
function quote(s: string): string {
  return `"${s.replace(/["\\]/g, " ").trim()}"`;
}

function firstString(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

/** IA file `length` is seconds ("231.45") or "M:SS"/"H:MM:SS". */
function parseLengthMs(length: string | undefined): number | undefined {
  if (!length) return undefined;
  if (length.includes(":")) {
    const parts = length.split(":").map(Number);
    if (parts.some((n) => Number.isNaN(n))) return undefined;
    const secs = parts.reduce((acc, n) => acc * 60 + n, 0);
    return Math.round(secs * 1000);
  }
  const secs = Number(length);
  return Number.isNaN(secs) ? undefined : Math.round(secs * 1000);
}

interface IaSearch {
  response?: { docs?: IaDoc[] };
}
interface IaDoc {
  identifier: string;
  title?: string;
  creator?: string | string[];
  licenseurl?: string;
}
interface IaMetadata {
  metadata?: { creator?: string | string[]; licenseurl?: string };
  files?: { name?: string; format?: string; title?: string; length?: string }[];
}
