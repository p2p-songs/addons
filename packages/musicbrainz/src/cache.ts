/**
 * A caching decorator for {@link MusicBrainzClient}.
 *
 * This exists because of how streams are resolved. Playback resolves **one
 * track at a time**, just-in-time (Plan §2) — so a 12-track album is 12
 * separate `/stream` requests, and every one of them looks up *the same
 * release* to find its disc+position. Measured: 12 requests, one distinct URL.
 * Against the client's ≤1 req/sec budget that is 12 seconds of serialized
 * MusicBrainz time to play one album, all of it re-fetching a document we
 * already had.
 *
 * It caches **entity lookups and the discography**, not free-text searches: the
 * former are machine-driven and repeat exactly, the latter are user-typed and
 * vary. Three properties matter, and they mirror `bitbop`'s `SearchCache` for
 * the same reasons:
 *
 * - **Single-flight.** The player prefetches ahead of playback, so several
 *   tracks' lookups are genuinely in flight at once. Without this they all miss
 *   and all fetch.
 * - **The caller's `AbortSignal` is deliberately not forwarded.** A shared load
 *   serves several callers; letting whichever one happens to be first cancel it
 *   would abort the others' work too.
 * - **Bounded and in-memory.** Addons are stateless (Plan §2); this is a
 *   request-coalescing buffer, not a datastore.
 *
 * `undefined` (a 404) is cached too, on a shorter TTL — "no such release" is a
 * real answer worth remembering, but it is the one that most plausibly changes.
 */
import type {
  MusicBrainzClient,
  MbAlbum,
  MbArtist,
  MbRecording,
  MbReleaseDetail,
  MbRelease,
} from "./client.js";

export interface CacheOptions {
  /** TTL for a found entity. MusicBrainz entities change slowly. */
  ttlMs?: number;
  /** TTL for a 404. Shorter — the answer most likely to change. */
  missTtlMs?: number;
  /** Max entries before the oldest is evicted. */
  maxEntries?: number;
  now?: () => number;
}

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const DEFAULT_MISS_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_ENTRIES = 500;

export class CachedMusicBrainz implements MusicBrainzClient {
  private readonly entries = new Map<string, { value: unknown; expiresAt: number }>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly ttlMs: number;
  private readonly missTtlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(
    private readonly inner: MusicBrainzClient,
    options: CacheOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.missTtlMs = options.missTtlMs ?? DEFAULT_MISS_TTL_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.now = options.now ?? Date.now;
  }

  /** Entries currently held — for tests and diagnostics. */
  get size(): number {
    return this.entries.size;
  }

  private async getOrLoad<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.entries.get(key);
    if (hit && hit.expiresAt > this.now()) return hit.value as T;
    if (hit) this.entries.delete(key);

    const pending = this.inFlight.get(key);
    if (pending) return pending as Promise<T>;

    const promise = load()
      .then((value) => {
        this.store(key, value, value === undefined ? this.missTtlMs : this.ttlMs);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, promise);
    return promise;
  }

  private store(key: string, value: unknown, ttlMs: number): void {
    if (this.entries.size >= this.maxEntries) {
      // Map preserves insertion order, so the first key is the oldest write.
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
    this.entries.set(key, { value, expiresAt: this.now() + ttlMs });
  }

  // --- cached: repeated verbatim by just-in-time resolution ---

  getRelease(uuid: string, signal?: AbortSignal): Promise<MbReleaseDetail | undefined> {
    return this.getOrLoad(`release:${uuid}`, () => this.inner.getRelease(uuid, signal));
  }

  getRecording(uuid: string, signal?: AbortSignal): Promise<MbRecording | undefined> {
    return this.getOrLoad(`recording:${uuid}`, () => this.inner.getRecording(uuid, signal));
  }

  getArtist(uuid: string, signal?: AbortSignal): Promise<MbArtist | undefined> {
    return this.getOrLoad(`artist:${uuid}`, () => this.inner.getArtist(uuid, signal));
  }

  artistDiscography(artistUuid: string, limit: number, signal?: AbortSignal): Promise<MbAlbum[]> {
    return this.getOrLoad(`discography:${artistUuid}:${limit}`, () =>
      this.inner.artistDiscography(artistUuid, limit, signal),
    );
  }

  // --- pass-through: user-typed, so they neither repeat nor want staleness ---

  searchArtists(query: string, limit: number, signal?: AbortSignal): Promise<MbArtist[]> {
    return this.inner.searchArtists(query, limit, signal);
  }

  searchReleases(query: string, limit: number, signal?: AbortSignal): Promise<MbRelease[]> {
    return this.inner.searchReleases(query, limit, signal);
  }

  searchRecordings(query: string, limit: number, signal?: AbortSignal): Promise<MbRecording[]> {
    return this.inner.searchRecordings(query, limit, signal);
  }
}
