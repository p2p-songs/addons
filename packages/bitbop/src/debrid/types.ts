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
   * Check whether a torrent (by infohash) is already cached, and if so list its
   * files. Rejects on transport/auth failure so the resolver can isolate it.
   */
  checkCache(infoHash: string, apiKey: string, signal?: AbortSignal): Promise<CacheResult>;

  /**
   * Unrestrict one file to a direct link. `fileId` comes from the
   * {@link DebridFile} chosen by `pickFile`. Rejects on failure.
   */
  resolveFile(infoHash: string, fileId: string, apiKey: string, signal?: AbortSignal): Promise<ResolvedLink>;
}

/** Raised when a provider call fails in a way worth distinguishing (auth vs. transient). */
export class DebridError extends Error {
  constructor(
    message: string,
    /** True for 401/403 — the user's key is bad, which is worth surfacing distinctly. */
    readonly isAuth: boolean = false,
  ) {
    super(message);
    this.name = "DebridError";
  }
}
