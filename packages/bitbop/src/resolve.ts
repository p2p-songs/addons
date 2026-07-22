/**
 * The resolve pipeline — `discover → pick file → resolve → rank/label → respond`,
 * all inside this one addon (Plan §2).
 *
 *   1. metadata:  the stream request's ids → artist/album/track + disc/position
 *   2. discover:  fan out to the user's indexers in parallel; merge candidates
 *   3. pre-check: one non-mutating read of what the user's debrid account
 *      already holds, so known-cached candidates are probed first and for free
 *   4. per torrent: check the user's debrid cache, pick the right track file,
 *      unrestrict it to a direct link
 *   5. rank/label the resulting streams and respond
 *
 * Step 3 exists because a debrid "is this cached?" is no longer a read (see
 * `debrid/realdebrid.ts`) — it costs an add and a cleanup. Playing an album
 * makes this pay for itself: the first track leaves the torrent on the account,
 * and every track after it resolves without adding anything.
 *
 * Two failure distinctions carry through, mirroring `stream-legal` (audit A-006):
 * a **total outage** (every indexer failed, or the debrid key is bad) becomes a
 * retryable error the handler turns into an uncacheable 500, so a transient
 * blip never poisons a cache with a long-lived "no streams"; a genuine
 * **no-match** is an empty success cached briefly.
 *
 * Everything is injected (metadata, indexers, provider) so the pipeline is unit
 * tested without network, a debrid account, or a live indexer.
 */
import type { Stream, StreamRequest } from "@p2p-songs/addon-sdk";
import type { BitbopConfig } from "./config.js";
import type { MetadataLookup, TrackContext } from "./metadata.js";
import type { Indexer, TorrentCandidate } from "./indexers/types.js";
import type { DebridProvider, TorrentRef } from "./debrid/types.js";
import { DebridError } from "./debrid/types.js";
import { pickFile, type FileMatch } from "./pick-file.js";
import { detectFormat } from "./format.js";

export interface ResolveDeps {
  metadata: MetadataLookup;
  /** The user's configured indexers (built from `config.indexers`). */
  indexers: Indexer[];
  /** The debrid adapter for `config.debrid.provider`. */
  provider: DebridProvider;
}

export interface ResolveResult {
  streams: Stream[];
  /** True when every discovery source failed, or the debrid credential was rejected — a real outage. */
  outage: boolean;
}

/**
 * How many discovered torrents we probe against debrid, best-first.
 *
 * Two budgets, because the two kinds of probe cost wildly different amounts.
 * A torrent already on the user's account is a read. One that isn't has to be
 * *added* to find out whether it's cached (see `realdebrid.ts`) — 4-6 API calls,
 * a write, and a cleanup. Real-Debrid allows 250 requests/minute and the player
 * prefetches ahead of playback, so an unbounded fan-out is a self-inflicted
 * rate limit. Cheap probes are generous; expensive ones are rationed.
 */
const MAX_TORRENTS_PROBED = 12;
const MAX_UNCACHED_PROBES = 3;

export async function resolveStreams(
  request: StreamRequest,
  config: BitbopConfig,
  deps: ResolveDeps,
  signal?: AbortSignal,
): Promise<ResolveResult> {
  // A metadata outage throws out of here → handler surfaces a retryable error.
  const track = await deps.metadata.resolve(request, signal);
  if (!track || !track.title) return { streams: [], outage: false };

  const { candidates, allIndexersFailed } = await discover(track, deps.indexers, signal);
  if (allIndexersFailed) return { streams: [], outage: true };
  if (candidates.length === 0) return { streams: [], outage: false };

  const ranked = rankCandidates(candidates, config);

  // One read that answers "which of these does the user already have?". For the
  // second and later tracks of an album this is the whole story — track 1 left
  // the torrent on the account — so the common case adds nothing at all.
  const pre = await listCachedQuietly(deps.provider, ranked, config, signal);
  if (pre.authFailed) return { streams: [], outage: true };
  const onAccount = pre.known;
  // Probe the free ones first: they can satisfy the request before we spend a
  // single write, and a hit here means the expensive budget goes unused.
  const probe = [...ranked]
    .sort((a, b) => Number(onAccount.has(b.infoHash.toLowerCase())) - Number(onAccount.has(a.infoHash.toLowerCase())))
    .slice(0, MAX_TORRENTS_PROBED);

  const streams: Stream[] = [];
  let authFailed = false;
  let uncachedProbes = 0;
  // Distinguish "the provider told us something" from "the provider is broken".
  // A torrent that is simply uncached or has no matching file is a *legitimate*
  // negative answer; a transport/5xx/rate-limit failure is not. If every probe
  // ends in the latter, this is an outage, not a no-match (audit A-011).
  let probed = 0;
  let providerFailures = 0;
  for (const candidate of probe) {
    if (signal?.aborted) break;
    if (streams.length >= config.maxResults) break;
    const handle = onAccount.get(candidate.infoHash.toLowerCase());
    if (handle === undefined) {
      if (uncachedProbes >= MAX_UNCACHED_PROBES) continue;
      uncachedProbes++;
    }
    probed++;
    try {
      const stream = await resolveCandidate(candidate, track, config, deps.provider, handle, signal);
      if (stream) streams.push(stream);
    } catch (error) {
      if (error instanceof DebridError && error.isAuth) {
        authFailed = true;
        break; // a bad key fails every candidate — stop, and report it as an outage
      }
      providerFailures++;
      // A single torrent failing (removed, transient) must not sink the response.
    }
  }

  if (streams.length === 0) {
    if (authFailed) return { streams: [], outage: true };
    // Every candidate we tried failed for a provider-side reason → retryable.
    if (probed > 0 && providerFailures === probed) return { streams: [], outage: true };
  }
  return { streams: rankStreams(streams, config), outage: false };
}

// --- discovery ---

async function discover(
  track: TrackContext,
  indexers: Indexer[],
  signal?: AbortSignal,
): Promise<{ candidates: TorrentCandidate[]; allIndexersFailed: boolean }> {
  const query = { artist: track.artist, ...(track.album ? { album: track.album } : {}), ...(track.title ? { track: track.title } : {}) };
  const settled = await Promise.allSettled(indexers.map((i) => i.search(query, signal)));

  const candidates: TorrentCandidate[] = [];
  let failures = 0;
  for (const r of settled) {
    if (r.status === "fulfilled") candidates.push(...r.value);
    else failures++;
  }
  return { candidates: dedupeByHash(candidates), allIndexersFailed: indexers.length > 0 && failures === indexers.length };
}

function dedupeByHash(candidates: TorrentCandidate[]): TorrentCandidate[] {
  const seen = new Map<string, TorrentCandidate>();
  for (const c of candidates) {
    const existing = seen.get(c.infoHash);
    // Keep the better-seeded copy of a hash found on multiple indexers.
    if (!existing || (c.seeders ?? 0) > (existing.seeders ?? 0)) seen.set(c.infoHash, c);
  }
  return [...seen.values()];
}

// --- per-candidate resolution ---

async function resolveCandidate(
  candidate: TorrentCandidate,
  track: TrackContext,
  config: BitbopConfig,
  provider: DebridProvider,
  /** Provider-side id when the torrent is already on the account — makes this a read. */
  handle: string | undefined,
  signal?: AbortSignal,
): Promise<Stream | undefined> {
  const ref: TorrentRef = handle === undefined ? { infoHash: candidate.infoHash } : { infoHash: candidate.infoHash, handle };
  const cache = await provider.checkCache(ref, config.debrid.apiKey, signal);
  // Cached-only is unconditional: an uncached torrent cannot be resolved now,
  // and offering a stream that won't play is worse than offering none (A-011).
  if (!cache.cached) return undefined;
  if (!cache.files || cache.files.length === 0) return undefined;

  const match = pickFile(cache.files, track, config.preferFormats);
  if (!match) return undefined;

  // Carry the handle forward so unrestricting doesn't re-add what we just added.
  const resolveRef: TorrentRef =
    cache.handle === undefined ? ref : { infoHash: candidate.infoHash, handle: cache.handle };
  const link = await provider.resolveFile(resolveRef, match.file.id, config.debrid.apiKey, signal);
  return toStream(candidate, match, link.url, link, track);
}

/**
 * The bulk pre-check is an optimization, never a gate: a provider may not
 * implement it, and a failure here (a rate limit, a blip) must not turn a
 * resolvable request into an outage. Either way we fall back to probing.
 */
async function listCachedQuietly(
  provider: DebridProvider,
  candidates: TorrentCandidate[],
  config: BitbopConfig,
  signal?: AbortSignal,
): Promise<{ known: Map<string, string>; authFailed: boolean }> {
  if (!provider.listCached || candidates.length === 0) return { known: new Map(), authFailed: false };
  try {
    const hashes = candidates.map((c) => c.infoHash.toLowerCase());
    return { known: await provider.listCached(hashes, config.debrid.apiKey, signal), authFailed: false };
  } catch (error) {
    // A rejected key is an outage no matter where we notice it. Anything else —
    // a rate limit, a blip — just costs us the optimization.
    if (error instanceof DebridError && error.isAuth) return { known: new Map(), authFailed: true };
    return { known: new Map(), authFailed: false };
  }
}

function toStream(
  candidate: TorrentCandidate,
  match: FileMatch,
  url: string,
  link: { filename?: string; sizeBytes?: number; expiresAt?: string },
  track: TrackContext,
): Stream {
  const format = detectFormat(link.filename ?? match.file.path) ?? candidate.format;
  const quality = format ? format : "audio";
  const seeders = candidate.seeders !== undefined ? ` · ${candidate.seeders}👤` : "";
  const certainty = match.strategy === "fuzzy" ? " · best-guess file" : "";

  const stream: Stream = {
    url,
    name: `Bitbop ${quality}`,
    description: `${track.artist} — ${track.title}\n${candidate.indexer}${seeders}${certainty}`,
    behaviorHints: {
      // Album grouping lets the player treat a resolved album as gapless-eligible.
      ...(track.album ? { bingeGroup: `bitbop-${normalizeGroup(track.artist, track.album)}` } : {}),
      filename: link.filename ?? basename(match.file.path),
      ...(link.sizeBytes !== undefined ? { videoSize: link.sizeBytes } : {}),
      // Debrid links expire; the hint is advisory only — the player's guarantee
      // is re-resolve-on-failure (Plan §8), never trust in this field.
      ...(link.expiresAt ? { expiresAt: link.expiresAt } : {}),
    },
  };
  return stream;
}

// --- ranking ---

/** Score a torrent before we spend a debrid round-trip on it: prefer preferred formats, then seeders. */
function rankCandidates(candidates: TorrentCandidate[], config: BitbopConfig): TorrentCandidate[] {
  return [...candidates].sort((a, b) => candidateScore(b, config) - candidateScore(a, config));
}

function candidateScore(c: TorrentCandidate, config: BitbopConfig): number {
  const formatRank = c.format ? formatPreference(c.format, config) : 0;
  const seeders = Math.log10((c.seeders ?? 0) + 1); // diminishing returns
  return formatRank * 10 + seeders;
}

/** Rank the final, resolved streams the same way (format preference, then seeders proxy in description). */
function rankStreams(streams: Stream[], config: BitbopConfig): Stream[] {
  return [...streams].sort((a, b) => streamFormatRank(b, config) - streamFormatRank(a, config));
}

function streamFormatRank(s: Stream, config: BitbopConfig): number {
  const fmt = /Bitbop (\w+)/.exec(s.name ?? "")?.[1];
  return fmt ? formatPreference(fmt, config) : 0;
}

/** Higher is more preferred. Unlisted formats rank below listed ones but are never filtered out. */
function formatPreference(format: string, config: BitbopConfig): number {
  const idx = config.preferFormats.findIndex((f) => f.toUpperCase() === format.toUpperCase());
  return idx < 0 ? 0 : config.preferFormats.length - idx;
}

function basename(path: string): string {
  return path.split("/").pop() ?? path;
}

function normalizeGroup(artist: string, album: string): string {
  return `${artist}-${album}`.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}
