/**
 * The production {@link SearchIndex}: a Meilisearch-backed index reached over
 * its REST API with the platform `fetch` — no client dependency, keeping this
 * package as dependency-light as `@p2p-songs/musicbrainz`.
 *
 * Why Meilisearch (over Typesense / Postgres FTS): MIT-licensed (this addon is
 * meant to be self-hosted by others), typo-tolerant and well-ranked out of the
 * box, single binary, low ops. Its default ranking rules — words → typo →
 * proximity → attribute → exactness — are already what we want: a title match
 * outranks an artist-name-only match, and `"justin bieber baby"` finds the song.
 *
 * ## One index, filtered by type
 *
 * All three content types share one index and are told apart by a filterable
 * `type` attribute, so a track query and an artist query rank within their own
 * kind. `searchableAttributes` is `["name","description"]` in that order, so a
 * name (title/artist/album) match weighs more than the one-line description
 * (which is usually the artist or the year).
 *
 * ## Ids
 *
 * Our content ids are `mbid:recording:<uuid>` — but a Meilisearch primary key
 * only allows `[A-Za-z0-9_-]`. So the document key is a sanitized copy and the
 * real id rides along in an `id` field, which is what search results return.
 *
 * ## Readiness
 *
 * `filterableAttributes` must be configured before a filtered search, so the
 * first call runs a memoized `ensureReady()` that creates the index, applies
 * settings, and waits for that settings task to finish. Everything after is a
 * plain search/upsert.
 */
import type { ContentType, MetaPreview } from "@p2p-songs/addon-sdk";
import { metaPreviewSchema } from "@p2p-songs/addon-sdk";
import type { SearchIndex } from "./search-index.js";

export interface MeiliOptions {
  /** Base URL of the Meilisearch instance, e.g. `http://127.0.0.1:7700`. */
  url: string;
  /** Master/API key, if the instance requires one. */
  apiKey?: string;
  /** Index name (default `catalog`). */
  indexName?: string;
  /** Bound on the one-time settings-task wait, ms (default 5000). */
  readyTimeoutMs?: number;
}

/** The stored document. `docId` is the sanitized primary key; `id` is the real one. */
interface CatalogDoc {
  docId: string;
  id: string;
  type: ContentType;
  name: string;
  description?: string;
  poster?: string;
  /**
   * The primary ranking field: `"<artist> <title>"` (description then name).
   * A user types the artist *and* the title ("justin bieber baby"), and putting
   * them adjacent in one field is what lets the real song — titled just "Baby"
   * by "Justin Bieber" — match the whole phrase and outrank a parody whose
   * *title* happens to contain "Justin Bieber Baby". Validated against Meili's
   * default ranking rules; name/description alone rank the parody first.
   */
  searchtext: string;
}

export class MeiliSearchIndex implements SearchIndex {
  private readonly base: string;
  private readonly index: string;
  private readonly headers: Record<string, string>;
  private readonly readyTimeoutMs: number;
  private ready?: Promise<void>;

  constructor(opts: MeiliOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.index = opts.indexName ?? "catalog";
    this.readyTimeoutMs = opts.readyTimeoutMs ?? 5000;
    this.headers = {
      "content-type": "application/json",
      ...(opts.apiKey ? { authorization: `Bearer ${opts.apiKey}` } : {}),
    };
  }

  async search(
    type: ContentType,
    query: string,
    limit: number,
    signal?: AbortSignal,
  ): Promise<MetaPreview[]> {
    // At most one retry: if the index has gone missing under us (Meili was
    // wiped/restarted), the first attempt 404s, we drop the stale readiness, and
    // the second attempt re-creates it. Without this, a running process that had
    // already initialized would search a vanished index forever and silently
    // serve nothing — the accelerator must self-heal, not need a redeploy.
    for (let attempt = 0; ; attempt++) {
      await this.ensureReady();
      try {
        const body = await this.req<{ hits: CatalogDoc[] }>(
          "POST",
          `/indexes/${this.index}/search`,
          { q: query, limit, filter: `type = ${JSON.stringify(type)}` },
          signal,
        );
        const out: MetaPreview[] = [];
        for (const hit of body.hits) {
          // Re-validate against the protocol on the way out: the index is a cache
          // of our own writes, but a schema-checked boundary means a stray/legacy
          // document can never become a malformed catalog response.
          const parsed = metaPreviewSchema.safeParse(docToPreview(hit));
          if (parsed.success) out.push(parsed.data);
        }
        return out;
      } catch (err) {
        if (attempt === 0 && isIndexMissing(err)) {
          this.ready = undefined;
          continue;
        }
        throw err;
      }
    }
  }

  async upsert(items: readonly MetaPreview[]): Promise<void> {
    if (items.length === 0) return;
    await this.ensureReady();
    const docs = items.map(previewToDoc);
    await this.req("PUT", `/indexes/${this.index}/documents`, docs);
  }

  /**
   * Create the index and apply settings once, memoized. A *failed* initialize
   * clears the memo so the next call retries — otherwise a transient Meili blip
   * during the first request would disable the accelerator for the whole
   * process lifetime.
   */
  private ensureReady(): Promise<void> {
    if (!this.ready) {
      this.ready = this.initialize().catch((err) => {
        this.ready = undefined;
        throw err;
      });
    }
    return this.ready;
  }

  private async initialize(): Promise<void> {
    // Create the index (idempotent — an existing index just yields a no-op task).
    await this.req("POST", "/indexes", { uid: this.index, primaryKey: "docId" });
    const task = await this.req<{ taskUid: number }>(
      "PATCH",
      `/indexes/${this.index}/settings`,
      {
        // `searchtext` (artist + title) leads so a full phrase query ranks the
        // right recording first; name/description stay searchable for partials.
        searchableAttributes: ["searchtext", "name", "description"],
        filterableAttributes: ["type"],
      },
    );
    await this.waitForTask(task.taskUid);
  }

  private async waitForTask(taskUid: number): Promise<void> {
    const deadline = Date.now() + this.readyTimeoutMs;
    for (;;) {
      const task = await this.req<{ status: string }>("GET", `/tasks/${taskUid}`);
      if (task.status === "succeeded") return;
      if (task.status === "failed" || task.status === "canceled") {
        throw new Error(`meilisearch settings task ${taskUid} ${task.status}`);
      }
      if (Date.now() > deadline) throw new Error(`meilisearch settings task ${taskUid} timed out`);
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  private async req<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: this.headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new MeiliError(`meilisearch ${method} ${path} → ${res.status}`, res.status);
    }
    return (await res.json()) as T;
  }
}

/** A non-2xx Meilisearch response, carrying the status so callers can react. */
class MeiliError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "MeiliError";
  }
}

/** True when the failure is Meilisearch reporting the index does not exist. */
function isIndexMissing(err: unknown): boolean {
  return err instanceof MeiliError && err.status === 404;
}

function sanitizeDocId(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]/g, "_");
}

function previewToDoc(p: MetaPreview): CatalogDoc {
  return {
    docId: sanitizeDocId(p.id),
    id: p.id,
    type: p.type,
    name: p.name,
    // Artist first, then title, so a full "artist + title" query matches the
    // phrase; empty description (e.g. an artist row) collapses to just the name.
    searchtext: p.description ? `${p.description} ${p.name}` : p.name,
    ...(p.description ? { description: p.description } : {}),
    ...(p.poster ? { poster: p.poster } : {}),
  };
}

function docToPreview(d: CatalogDoc): unknown {
  return {
    type: d.type,
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    ...(d.poster ? { poster: d.poster } : {}),
  };
}
