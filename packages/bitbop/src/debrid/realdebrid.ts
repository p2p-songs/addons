/**
 * Real-Debrid adapter for the {@link DebridProvider} port.
 *
 * The one invariant that shapes every method: the caller's `apiKey` is passed
 * in per call and used as the Bearer token, and it is read from nowhere else —
 * no env var, no stored field, no default (Plan §3, Checklist §3). Bitbop holds
 * no audio: the sequence ends at an *unrestricted link* on Real-Debrid's CDN,
 * which the player fetches directly.
 *
 * ## Why checking the cache is not a read
 *
 * Real-Debrid withdrew `/torrents/instantAvailability`. What remains is a state
 * machine, and it only reveals cachedness at the very end:
 *
 *   addMagnet(hash)              → id, status `magnet_conversion`
 *   info(id)                     → status `waiting_files_selection`
 *   selectFiles(id, ids)         → status `queued` | `downloading` | `downloaded`
 *   info(id)                     → `downloaded` *fast* ⇒ RD already had the bytes
 *
 * A torrent will **never** report `downloaded` before file selection, so there
 * is no way to ask "is this cached?" without committing to the answer. Selecting
 * is also what starts a download if it *isn't* cached — which is precisely the
 * thing a music player must not do mid-queue.
 *
 * Three consequences shape this file:
 *
 * 1. **We select audio files only**, never `files=all`. A miss then costs RD a
 *    few tracks rather than an entire album — and the links array stays free of
 *    cover art, logs, and cue sheets.
 * 2. **Anything we add that turns out uncached is deleted before we return.** A
 *    cache check never leaves a download running. A torrent the user already had
 *    is never deleted — we only clean up our own mess.
 * 3. **{@link listCached} is the cheap path and, for albums, the common one.**
 *    `GET /torrents` is a plain read that answers every candidate at once, and
 *    once track 1 has resolved, the album torrent is on the account — so the
 *    rest of the album never adds anything at all.
 *
 * `fetch` and `sleep` are injected so the whole state machine is testable
 * without network, an account, or real time.
 */
import { isAudioFile } from "../format.js";
import {
  DebridError,
  type CacheResult,
  type DebridFile,
  type DebridProvider,
  type ResolvedLink,
  type TorrentRef,
} from "./types.js";

const RD_BASE = "https://api.real-debrid.com/rest/1.0";

/** Terminal-success status: RD holds the bytes and can unrestrict immediately. */
const STATUS_DOWNLOADED = "downloaded";
/** Statuses meaning "RD is fetching this" — i.e. not cached, and we must not wait. */
const STATUS_IN_PROGRESS = new Set(["queued", "downloading", "compressing", "uploading"]);
/** Dead ends. Nothing to wait for; clean up. */
const STATUS_TERMINAL_ERROR = new Set(["magnet_error", "error", "virus", "dead"]);

/**
 * Wall-clock budget for taking a torrent from "unknown" to a verdict.
 *
 * Calibrated against the live API rather than guessed. Measured on a cached
 * torrent: `addMagnet` → 250ms, `waiting_files_selection` → 636ms, selection
 * call → 895ms, `downloaded` → **1330ms**; RD round-trips run ~260ms (p50).
 * 3s is a little over 2× the observed flip — enough headroom for a slower link
 * or an album with many files, without waiting on anything real.
 *
 * The budget covers **the whole check**, starting before `addMagnet`, not just
 * the polling. Two rounds of getting this wrong:
 *
 *  1. Counting poll *attempts* ignored the ~260ms round-trip each one costs, so
 *     a nominal 2.5s budget ran 4.8s.
 *  2. Making it wall-clock but starting the clock *after* the add and selection
 *     left three fixed round-trips outside it — measured against a live account,
 *     misses cost 848ms–6844ms against a "3s" budget.
 *
 * Only the cleanup `delete` sits outside, because it must run regardless of how
 * much time is left.
 */
const CACHE_SETTLE_BUDGET_MS = 3_000;
const CACHE_POLL_INTERVAL_MS = 400;

/** Pages of `GET /torrents` to scan in {@link listCached}. RD returns newest-first. */
const LIST_PAGE_SIZE = 100;
const LIST_MAX_PAGES = 3;

interface RdFile {
  id: number;
  path: string;
  bytes?: number;
  selected?: number;
}

interface RdInfo {
  id?: string;
  status: string;
  files: RdFile[];
  links: string[];
}

interface RdListItem {
  id?: string;
  hash?: string;
  status?: string;
}

export interface RealDebridOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** Injected for tests, so polling doesn't spend real time. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected alongside `sleep` so the wall-clock bound is deterministic in tests. */
  now?: () => number;
  /** Wall-clock budget for a freshly-added torrent to report `downloaded`. */
  settleBudgetMs?: number;
}

export class RealDebridProvider implements DebridProvider {
  readonly id = "realdebrid";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly settleBudgetMs: number;

  constructor(options: RealDebridOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = options.baseUrl ?? RD_BASE;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.now = options.now ?? Date.now;
    this.settleBudgetMs = options.settleBudgetMs ?? CACHE_SETTLE_BUDGET_MS;
  }

  /**
   * Read-only scan of the account's torrent list for hashes we care about.
   * Bounded: RD lists newest-first, and anything this addon put there is recent,
   * so a hash beyond the scan is simply reported absent — the caller falls back
   * to {@link checkCache} and at worst pays one add.
   */
  async listCached(infoHashes: string[], apiKey: string, signal?: AbortSignal): Promise<Map<string, string>> {
    const wanted = new Set(infoHashes.map((h) => h.toLowerCase()));
    const found = new Map<string, string>();
    if (wanted.size === 0) return found;

    for (let page = 1; page <= LIST_MAX_PAGES; page++) {
      const items = await this.get<RdListItem[] | undefined>(
        `/torrents?page=${page}&limit=${LIST_PAGE_SIZE}`,
        apiKey,
        signal,
      );
      if (!Array.isArray(items) || items.length === 0) break;

      for (const item of items) {
        if (item.status !== STATUS_DOWNLOADED || !item.hash || !item.id) continue;
        const hash = item.hash.toLowerCase();
        if (wanted.has(hash) && !found.has(hash)) found.set(hash, item.id);
      }
      if (found.size === wanted.size || items.length < LIST_PAGE_SIZE) break;
    }
    return found;
  }

  async checkCache(ref: TorrentRef, apiKey: string, signal?: AbortSignal): Promise<CacheResult> {
    // A handle means the torrent is already on the account: pure read, no cleanup.
    if (ref.handle) {
      const info = await this.info(ref.handle, apiKey, signal);
      return info.status === STATUS_DOWNLOADED
        ? { cached: true, files: selectedFiles(info), handle: ref.handle }
        : { cached: false };
    }

    // Start the clock *before* the add: the add, the first info, and the
    // selection call are three round-trips that must come out of the budget,
    // not sit outside it.
    const deadline = this.now() + this.settleBudgetMs;
    const id = await this.addMagnet(ref.infoHash, apiKey, signal);
    // From here every exit path must either keep a *cached* torrent or delete
    // what we just added — that is what makes the cleanup safe to do at all.
    try {
      const info = await this.selectAudioAndSettle(id, apiKey, deadline, signal);
      if (info.status !== STATUS_DOWNLOADED) {
        await this.deleteQuietly(id, apiKey);
        return { cached: false };
      }
      return { cached: true, files: selectedFiles(info), handle: id };
    } catch (error) {
      await this.deleteQuietly(id, apiKey);
      throw error;
    }
  }

  async resolveFile(ref: TorrentRef, fileId: string, apiKey: string, signal?: AbortSignal): Promise<ResolvedLink> {
    const info = ref.handle
      ? await this.info(ref.handle, apiKey, signal)
      : await this.settleFresh(ref.infoHash, apiKey, signal);

    if (info.status !== STATUS_DOWNLOADED) {
      throw new DebridError(`torrent not cached (status: ${info.status})`);
    }
    const link = linkForFile(info, fileId);

    const unrestricted = await this.post<{ download?: string; filename?: string; filesize?: number }>(
      "/unrestrict/link",
      { link },
      apiKey,
      signal,
    );
    if (!unrestricted.download) throw new DebridError("unrestrict returned no download url");
    if (!/^https:\/\//i.test(unrestricted.download)) {
      throw new DebridError("unrestrict returned a non-https url"); // never hand the player a non-https link
    }

    const resolved: ResolvedLink = { url: unrestricted.download };
    if (unrestricted.filename) resolved.filename = unrestricted.filename;
    if (typeof unrestricted.filesize === "number") resolved.sizeBytes = unrestricted.filesize;
    return resolved;
  }

  // --- the state machine ---

  /**
   * Add a torrent and drive it to a verdict under one budget. Used by
   * `resolveFile` when it has no handle — a caller that skipped `checkCache`,
   * or whose handle went stale.
   */
  private async settleFresh(infoHash: string, apiKey: string, signal?: AbortSignal): Promise<RdInfo> {
    const deadline = this.now() + this.settleBudgetMs;
    const id = await this.addMagnet(infoHash, apiKey, signal);
    return this.selectAudioAndSettle(id, apiKey, deadline, signal);
  }

  /**
   * Drive a freshly-added torrent to a verdict: wait for file selection to be
   * possible, select **audio only**, then give it a short budget to flip to
   * `downloaded`. Returns whatever status it settled on — the caller decides
   * whether that means "cached" and owns the cleanup.
   */
  private async selectAudioAndSettle(
    id: string,
    apiKey: string,
    /** Absolute deadline set by the caller, before the torrent was even added. */
    deadline: number,
    signal?: AbortSignal,
  ): Promise<RdInfo> {
    let info = await this.info(id, apiKey, signal);

    // A brand-new magnet is briefly in `magnet_conversion` before RD can list files.
    while (info.status !== "waiting_files_selection" && !this.settled(info) && this.now() < deadline) {
      await this.sleep(CACHE_POLL_INTERVAL_MS);
      info = await this.info(id, apiKey, signal);
    }
    if (STATUS_TERMINAL_ERROR.has(info.status)) {
      throw new DebridError(`torrent unusable (status: ${info.status})`);
    }

    if (info.status === "waiting_files_selection") {
      const audioIds = info.files.filter((f) => isAudioFile(f.path)).map((f) => String(f.id));
      // No audio at all: selecting nothing would be an error, and this torrent
      // can never serve a track. Treat as a miss and let the caller clean up.
      if (audioIds.length === 0) return { ...info, status: "no_audio_files" };
      await this.post(`/torrents/selectFiles/${encodeURIComponent(id)}`, { files: audioIds.join(",") }, apiKey, signal);
      info = await this.info(id, apiKey, signal);
    }

    // Cached ⇒ flips to `downloaded` almost at once. Anything still in progress
    // when the budget runs out is a real download, which we never wait for.
    while (STATUS_IN_PROGRESS.has(info.status) && this.now() < deadline) {
      await this.sleep(CACHE_POLL_INTERVAL_MS);
      info = await this.info(id, apiKey, signal);
    }
    return info;
  }

  private settled(info: RdInfo): boolean {
    return info.status === STATUS_DOWNLOADED || STATUS_IN_PROGRESS.has(info.status) || STATUS_TERMINAL_ERROR.has(info.status);
  }

  private async addMagnet(infoHash: string, apiKey: string, signal?: AbortSignal): Promise<string> {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    const added = await this.post<{ id?: string }>("/torrents/addMagnet", { magnet }, apiKey, signal);
    if (!added?.id) throw new DebridError("addMagnet returned no torrent id");
    return added.id;
  }

  private async info(id: string, apiKey: string, signal?: AbortSignal): Promise<RdInfo> {
    const info = await this.get<RdInfo>(`/torrents/info/${encodeURIComponent(id)}`, apiKey, signal);
    return { ...info, files: info?.files ?? [], links: info?.links ?? [] };
  }

  /**
   * Cleanup is best-effort by design: the caller is already returning "not
   * cached" or propagating a failure, and a delete that fails must not convert
   * either into a *different* error. Worst case RD keeps one torrent the next
   * `listCached` will happily reuse.
   */
  private async deleteQuietly(id: string, apiKey: string): Promise<void> {
    try {
      await this.request(`/torrents/delete/${encodeURIComponent(id)}`, { method: "DELETE" }, apiKey, undefined);
    } catch {
      /* ignore */
    }
  }

  // --- transport ---

  private async get<T>(path: string, apiKey: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "GET" }, apiKey, signal);
  }

  private async post<T>(path: string, form: Record<string, string>, apiKey: string, signal?: AbortSignal): Promise<T> {
    const body = new URLSearchParams(form).toString();
    return this.request<T>(
      path,
      { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } },
      apiKey,
      signal,
    );
  }

  private async request<T>(path: string, init: RequestInit, apiKey: string, signal?: AbortSignal): Promise<T> {
    const res = await this.fetchImpl(this.base + path, {
      ...init,
      signal: signal ?? null,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${apiKey}` },
    });
    if (res.status === 401 || res.status === 403) {
      // Distinct so the resolver can tell "your key is wrong" from "RD hiccuped".
      throw new DebridError(`Real-Debrid auth failed (${res.status})`, true);
    }
    if (!res.ok) throw new DebridError(`Real-Debrid ${path} → ${res.status}`);
    // Some endpoints (selectFiles, delete) return 204 with no body.
    if (res.status === 204) return undefined as T;

    const text = await res.text();
    if (!text) return undefined as T;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new DebridError(`Real-Debrid ${path} → unparseable response`);
    }
    // RD reports application errors in a 200 body. Left unchecked these surface
    // later as a confusing structural complaint ("addMagnet returned no id")
    // instead of the actual cause.
    assertNoRdError(parsed, path);
    return parsed as T;
  }
}

/**
 * Real-Debrid's documented `error_code` values, mapped to what a caller can act
 * on. Auth codes matter most: they are the difference between "this user's key
 * is wrong" (stop, report it) and "one torrent misbehaved" (skip, continue).
 */
function assertNoRdError(body: unknown, path: string): void {
  if (typeof body !== "object" || body === null) return;
  const record = body as { error?: unknown; error_code?: unknown };
  if (typeof record.error_code !== "number") return;

  const code = record.error_code;
  const detail = typeof record.error === "string" ? record.error : "unknown error";
  // 8–15 are the token/permission family; anything else is transient or per-torrent.
  const isAuth = code >= 8 && code <= 15;
  throw new DebridError(`Real-Debrid ${path} → ${rdErrorLabel(code)} (${detail})`, isAuth, code);
}

function rdErrorLabel(code: number): string {
  if (code >= 8 && code <= 15) return "authentication error";
  switch (code) {
    case 5:
    case 34:
      return "rate limited"; // RD allows 250 requests/minute
    case 21:
      return "too many active downloads";
    case 22:
      return "IP not allowed";
    case 35:
      return "infringing file";
    case 7:
      return "resource not found";
    default:
      return `error ${code}`;
  }
}

/**
 * RD lists `links` in the order of *selected* files; map a file id to its link.
 *
 * The alignment is positional and RD does not always honour it — a torrent whose
 * selection was changed out from under us can come back with a `links` array
 * that no longer corresponds one-to-one. Both MediaFusion and StremThru carry
 * explicit guards for exactly this. Rather than serve whichever track happens to
 * sit at that index, we refuse: handing the player a confidently wrong song is
 * the failure mode this addon exists to avoid (Plan §2a).
 */
function linkForFile(info: RdInfo, fileId: string): string {
  const selected = info.files.filter((f) => f.selected === 1);
  if (selected.length !== info.links.length) {
    throw new DebridError(
      `Real-Debrid file/link mismatch (${selected.length} selected, ${info.links.length} links)`,
    );
  }
  const idx = selected.findIndex((f) => String(f.id) === fileId);
  if (idx < 0) throw new DebridError("selected file has no resolvable link");
  const link = info.links[idx];
  if (!link) throw new DebridError("selected file has no resolvable link");
  return link;
}

/** The files RD has selected (audio-vs-art filtering happens later in `pickFile`). */
function selectedFiles(info: RdInfo): DebridFile[] {
  return info.files
    .filter((f) => f.selected === 1 || info.files.every((g) => g.selected === undefined))
    .map((f) => {
      const file: DebridFile = { id: String(f.id), path: f.path.replace(/^\//, "") };
      if (typeof f.bytes === "number") file.sizeBytes = f.bytes;
      return file;
    });
}
