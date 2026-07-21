/**
 * Real-Debrid adapter for the {@link DebridProvider} port.
 *
 * The one invariant that shapes every method: the caller's `apiKey` is passed
 * in per call and used as the Bearer token, and it is read from nowhere else —
 * no env var, no stored field, no default (Plan §3, Checklist §3). Bitbop holds
 * no audio: the sequence ends at an *unrestricted link* on Real-Debrid's CDN,
 * which the player fetches directly.
 *
 * The Real-Debrid torrent flow, faithfully:
 *   addMagnet(hash)         → a torrent id on the user's account
 *   selectFiles(id, all)    → RD won't expose per-file links until files are selected
 *   info(id)                → { status, files[], links[] }  (links track selected files, in order)
 *   unrestrict(link)        → a direct, Range-servable https download URL
 *
 * "Cached" is `status === "downloaded"`: RD already has the bytes and resolution
 * is instant. Anything else means RD would have to fetch the torrent first,
 * which a player can't wait on mid-queue — so the resolver skips those, and
 * Bitbop only ever serves already-cached torrents.
 *
 * `fetch` is injected so the whole sequence is testable without network or a
 * real account.
 */
import { DebridError, type CacheResult, type DebridFile, type DebridProvider, type ResolvedLink } from "./types.js";

const RD_BASE = "https://api.real-debrid.com/rest/1.0";

interface RdInfo {
  status: string;
  files: { id: number; path: string; bytes?: number; selected?: number }[];
  links: string[];
}

export interface RealDebridOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

export class RealDebridProvider implements DebridProvider {
  readonly id = "realdebrid";
  private readonly fetchImpl: typeof fetch;
  private readonly base: string;

  constructor(options: RealDebridOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.base = options.baseUrl ?? RD_BASE;
  }

  async checkCache(infoHash: string, apiKey: string, signal?: AbortSignal): Promise<CacheResult> {
    const info = await this.addAndInspect(infoHash, apiKey, signal);
    const files = selectedFiles(info);
    const cached = info.status === "downloaded";
    return files.length > 0 ? { cached, files } : { cached };
  }

  async resolveFile(infoHash: string, fileId: string, apiKey: string, signal?: AbortSignal): Promise<ResolvedLink> {
    const info = await this.addAndInspect(infoHash, apiKey, signal);
    if (info.status !== "downloaded") {
      throw new DebridError(`torrent not cached (status: ${info.status})`);
    }
    const link = linkForFile(info, fileId);
    if (!link) throw new DebridError("selected file has no resolvable link");

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

  /** addMagnet → selectFiles(all) → info. Shared by both public methods. */
  private async addAndInspect(infoHash: string, apiKey: string, signal?: AbortSignal): Promise<RdInfo> {
    const magnet = `magnet:?xt=urn:btih:${infoHash}`;
    const added = await this.post<{ id?: string }>("/torrents/addMagnet", { magnet }, apiKey, signal);
    if (!added.id) throw new DebridError("addMagnet returned no torrent id");
    // Select all files so RD exposes per-file links; we pick among them ourselves.
    await this.post("/torrents/selectFiles/" + encodeURIComponent(added.id), { files: "all" }, apiKey, signal);
    return this.get<RdInfo>("/torrents/info/" + encodeURIComponent(added.id), apiKey, signal);
  }

  private async get<T>(path: string, apiKey: string, signal?: AbortSignal): Promise<T> {
    return this.request<T>(path, { method: "GET" }, apiKey, signal);
  }

  private async post<T>(
    path: string,
    form: Record<string, string>,
    apiKey: string,
    signal?: AbortSignal,
  ): Promise<T> {
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
    // Some endpoints (selectFiles) return 204 with no body.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }
}

/** RD lists `links` in the order of *selected* files; map a file id to its link. */
function linkForFile(info: RdInfo, fileId: string): string | undefined {
  const selected = info.files.filter((f) => f.selected === 1);
  const idx = selected.findIndex((f) => String(f.id) === fileId);
  if (idx < 0 || idx >= info.links.length) return undefined;
  return info.links[idx];
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
