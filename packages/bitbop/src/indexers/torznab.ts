/**
 * A Torznab indexer client (Jackett / Prowlarr). Torznab is the de-facto search
 * API those aggregators expose; it's Newznab-shaped RSS/XML with torrent
 * extensions. We read a handful of fields per item, so rather than take an XML
 * parser dependency we extract exactly those with a small, tested scanner.
 *
 * The indexer URL and API key both come from the user's config — Bitbop never
 * embeds a tracker (Plan §3). `fetch` is injected so the client is testable
 * without network.
 */
import type { Indexer, ReleaseQuery, TorrentCandidate } from "./types.js";
import type { IndexerConfig } from "../config.js";
import { detectFormat } from "../format.js";

export interface TorznabOptions {
  fetchImpl?: typeof fetch;
  /** Per-request timeout; the resolver also imposes its own outer deadline. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const INFOHASH_RE = /^[0-9a-fA-F]{40}$/;

export class TorznabIndexer implements Indexer {
  readonly name: string;
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: IndexerConfig, options: TorznabOptions = {}) {
    this.name = config.name ?? safeHost(config.url);
    this.base = config.url;
    this.apiKey = config.apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async search(query: ReleaseQuery, signal?: AbortSignal): Promise<TorrentCandidate[]> {
    const url = new URL(this.base);
    url.searchParams.set("apikey", this.apiKey);
    // t=music is Torznab's music search; indexers that don't support it fall
    // back to a generic search on the same `q`.
    url.searchParams.set("t", "search");
    url.searchParams.set("q", buildQueryString(query));

    const res = await this.fetchWithTimeout(url, signal);
    if (!res.ok) throw new Error(`indexer ${this.name} returned ${res.status}`);
    const xml = await res.text();
    return parseTorznab(xml, this.name);
  }

  private async fetchWithTimeout(url: URL, signal?: AbortSignal): Promise<Response> {
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      // Never log the URL: it carries the indexer apikey (Checklist §7).
      return await this.fetchImpl(url, { signal: controller.signal, headers: { accept: "application/xml, text/xml" } });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** Build the search string. Album context narrows to the release; otherwise search the track. */
export function buildQueryString(query: ReleaseQuery): string {
  const subject = query.album ?? query.track ?? "";
  return [query.artist, subject].filter(Boolean).join(" ").trim();
}

/**
 * Parse a Torznab RSS response into candidates. Tolerant by design: indexers
 * vary in which fields they populate, so a missing size/seeders is fine, but an
 * item without a usable infohash is dropped (the debrid provider resolves from
 * the hash, so a candidate without one is useless).
 */
export function parseTorznab(xml: string, indexerName: string): TorrentCandidate[] {
  const out: TorrentCandidate[] = [];
  for (const item of extractBlocks(xml, "item")) {
    const title = decodeXml(firstTag(item, "title") ?? "");
    if (!title) continue;

    const attrs = torznabAttrs(item);
    const infoHash = normalizeHash(attrs["infohash"] ?? hashFromMagnet(attrs["magneturl"] ?? enclosureUrl(item)));
    if (!infoHash) continue;

    const candidate: TorrentCandidate = { indexer: indexerName, title, infoHash };
    const size = numeric(attrs["size"] ?? firstTag(item, "size"));
    if (size !== undefined) candidate.sizeBytes = size;
    const seeders = numeric(attrs["seeders"]);
    if (seeders !== undefined) candidate.seeders = seeders;
    const format = detectFormat(title);
    if (format) candidate.format = format;

    out.push(candidate);
  }
  return out;
}

// --- tiny XML scanning (only what Torznab needs) ---

function* extractBlocks(xml: string, tag: string): Generator<string> {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) yield m[1]!;
}

function firstTag(block: string, tag: string): string | undefined {
  const m = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(block);
  if (m) return stripCdata(m[1]!).trim();
  return undefined;
}

/** Collect `<torznab:attr name="x" value="y"/>` (and the newznab: variant) into a map. */
function torznabAttrs(block: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const re = /<(?:torznab|newznab):attr\b[^>]*\bname="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*\/?>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(block)) !== null) attrs[m[1]!.toLowerCase()] = decodeXml(m[2]!);
  return attrs;
}

function enclosureUrl(block: string): string | undefined {
  const m = /<enclosure\b[^>]*\burl="([^"]+)"/i.exec(block);
  return m ? decodeXml(m[1]!) : undefined;
}

function hashFromMagnet(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const m = /btih:([0-9a-fA-F]{40})/i.exec(value);
  return m ? m[1] : undefined;
}

function normalizeHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return INFOHASH_RE.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

function numeric(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function stripCdata(s: string): string {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : s;
}

function decodeXml(s: string): string {
  return stripCdata(s)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "indexer";
  }
}
