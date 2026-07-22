/**
 * The debrid port. Bitbop's pipeline is provider-agnostic; a provider is a thin
 * adapter over one debrid service's HTTP API (Real-Debrid, AllDebrid, …). Two
 * legal invariants are the port's whole reason for existing (Plan §3,
 * Checklist §3):
 *
 * - **Every call uses the caller's own credentials.** The `apiKey` is passed in
 *   per request, straight from that request's `/configure` config. A provider
 *   implementation must not read a key from anywhere else — no env var, no
 *   module-level default, no pooled account.
 * - **Bitbop never holds audio bytes.** A provider returns *links and file
 *   metadata* only. The unrestricted URL points at the provider's own CDN; the
 *   bytes flow provider → player, never through Bitbop.
 */

/** One file inside a torrent, as the debrid provider reports it. */
export interface DebridFile {
  /** Provider-local file id/index, used to select this file for unrestricting. */
  id: string;
  /** Path within the torrent, e.g. "Disc 1/03 - One More Time.flac". */
  path: string;
  /** Size in bytes, when known — corroborates track vs. art/log files. */
  sizeBytes?: number;
}

/**
 * A torrent, as addressed across a provider call. `infoHash` always identifies
 * it; `handle` is an optional provider-side id (Real-Debrid's torrent id) for a
 * torrent already materialized on the account.
 *
 * The handle exists because on Real-Debrid — and every provider that followed it
 * once `/torrents/instantAvailability` was withdrawn — *asking* whether a
 * torrent is cached is the same operation as *adding* it. Threading the handle
 * from `checkCache` into `resolveFile` is what stops a single resolution from
 * adding the same torrent to the user's account twice.
 */
export interface TorrentRef {
  infoHash: string;
  /** Provider-side torrent id from a prior {@link DebridProvider.checkCache} or {@link DebridProvider.listCached}. */
  handle?: string;
}

/** The result of checking whether a torrent's files are already cached. */
export interface CacheResult {
  /** True if the provider can serve this torrent's files without a fresh download. */
  cached: boolean;
  /**
   * The file list, when the provider can enumerate it from cache. `pickFile`
   * needs this to choose the right track. When absent (uncached, or a provider
   * that won't list until added), file selection can't run and the candidate is
   * skipped (Bitbop only ever serves already-cached torrents).
   */
  files?: DebridFile[];
  /** Provider-side id of the torrent this check resolved to; pass to `resolveFile`. */
  handle?: string;
}

/** A resolved, directly-playable link to one file. */
export interface ResolvedLink {
  /** Direct https URL on the provider's CDN. Range-servable, browser-playable. */
  url: string;
  /** Chosen file's display name, for the stream label. */
  filename?: string;
  sizeBytes?: number;
  /** Absolute ISO-8601 instant the link expires, when the provider states it. */
  expiresAt?: string;
}

/**
 * A debrid service adapter. All methods take the caller's `apiKey` explicitly;
 * there is no constructor-stored credential, precisely so the "own credentials"
 * invariant can't be bypassed by a stale instance.
 */
export interface DebridProvider {
  /** Stable id matching {@link import("../config.js").DebridProviderId}. */
  readonly id: string;

  /**
   * **Non-mutating** bulk pre-check: of these infohashes, which are already
   * sitting downloaded on the user's account? Returns infohash → handle.
   *
   * This is the cheap path, and for an album it is the *common* path: resolving
   * track 1 leaves the album torrent on the account, so tracks 2…n are answered
   * here for one request instead of one add apiece. Implementations must not add,
   * select, or delete anything. Optional — a provider without a listing API can
   * omit it and every candidate goes through {@link checkCache}.
   */
  listCached?(infoHashes: string[], apiKey: string, signal?: AbortSignal): Promise<Map<string, string>>;

  /**
   * Check whether a torrent is already cached, and if so list its files.
   *
   * When `ref.handle` is set this is a read. When it is not, the provider may
   * have to *materialize* the torrent to find out (see {@link TorrentRef}) — in
   * which case it must clean up after itself: anything it added that turns out
   * not to be cached has to be removed before returning, so a cache check never
   * leaves a download running on the user's account. A torrent the user already
   * had is never deleted.
   *
   * Rejects on transport/auth failure so the resolver can isolate it.
   */
  checkCache(ref: TorrentRef, apiKey: string, signal?: AbortSignal): Promise<CacheResult>;

  /**
   * Unrestrict one file to a direct link. `fileId` comes from the
   * {@link DebridFile} chosen by `pickFile`; pass the `handle` from the
   * {@link CacheResult} so this doesn't re-add what `checkCache` just added.
   * Rejects on failure.
   */
  resolveFile(ref: TorrentRef, fileId: string, apiKey: string, signal?: AbortSignal): Promise<ResolvedLink>;
}

/** Raised when a provider call fails in a way worth distinguishing (auth vs. transient). */
export class DebridError extends Error {
  constructor(
    message: string,
    /** True for 401/403 and Real-Debrid's auth error codes — the user's key is bad. */
    readonly isAuth: boolean = false,
    /** Provider-specific error code, when the provider reports one (RD's `error_code`). */
    readonly code?: number,
  ) {
    super(message);
    this.name = "DebridError";
  }
}
