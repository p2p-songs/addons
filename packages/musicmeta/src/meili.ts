/**
 * The production {@link SearchIndex}: a **read-only** Meilisearch client reached
 * over its REST API with the platform `fetch` — no client dependency, keeping
 * this package as dependency-light as `@p2p-songs/musicbrainz`.
 *
 * `musicmeta` only ever reads. The index is built and kept current by the offline
 * pipeline (`@p2p-songs/catalog-builder`): it creates the index, applies the
 * search settings (searchable attributes, `type` filter, popularity ranking), and
 * swaps in each new dataset atomically. So there is nothing here that creates the
 * index, writes documents, or configures settings — this queries an index the
 * importer owns.
 *
 * Why Meilisearch (over Typesense / Postgres FTS): MIT-licensed (this addon is
 * meant to be self-hosted by others), typo-tolerant and well-ranked out of the
 * box, single binary, low ops.
 *
 * ## One index, filtered by type
 *
 * All three content types share one index and are told apart by a filterable
 * `type` attribute, so a track query and an artist query rank within their own
 * kind, and a facet count by `type` gives the per-type catalogue {@link stats}.
 *
 * ## Ids and posters
 *
 * Stored documents key on a sanitized `docId` (Meilisearch primary keys allow
 * only `[A-Za-z0-9_-]`); the real `mbid:…` id rides along in an `id` field, which
 * is what results return. The curated documents carry no poster, so an **album**
 * preview's poster is synthesized from its release id at read time (the Cover Art
 * Archive URL is deterministic) — matching what direct album search always did.
 *
 * ## Missing index
 *
 * Before the importer's first run the index does not exist. A search then 404s;
 * rather than treat that as an error (or, worse, create a half-configured index),
 * {@link search} returns `[]` and {@link stats} returns zeros — a fresh deployment
 * simply shows an empty catalogue until the first import lands.
 */
import { parseMbid, metaPreviewSchema, type ContentType, type MetaPreview } from "@p2p-songs/addon-sdk";
import { releaseFrontCover } from "./coverart.js";
import type { CatalogStats, SearchIndex } from "./search-index.js";

export interface MeiliOptions {
  /** Base URL of the Meilisearch instance, e.g. `http://127.0.0.1:7700`. */
  url: string;
  /** Master/API key, if the instance requires one. */
  apiKey?: string;
  /** Index name (default `catalog`). */
  indexName?: string;
}

/** The stored document, as written by the importer. `docId` is the primary key. */
interface CatalogDoc {
  docId: string;
  id: string;
  type: ContentType;
  name: string;
  description?: string;
  poster?: string;
}

export class MeiliSearchIndex implements SearchIndex {
  private readonly base: string;
  private readonly index: string;
  private readonly headers: Record<string, string>;

  constructor(opts: MeiliOptions) {
    this.base = opts.url.replace(/\/+$/, "");
    this.index = opts.indexName ?? "catalog";
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
    let body: { hits: CatalogDoc[] };
    try {
      body = await this.req<{ hits: CatalogDoc[] }>(
        "POST",
        `/indexes/${this.index}/search`,
        { q: query, limit, filter: `type = ${JSON.stringify(type)}` },
        signal,
      );
    } catch (err) {
      if (isIndexMissing(err)) return []; // not imported yet → empty catalogue
      throw err;
    }
    const out: MetaPreview[] = [];
    for (const hit of body.hits) {
      // Re-validate against the protocol on the way out: a stray/legacy document
      // can never become a malformed catalog response.
      const parsed = metaPreviewSchema.safeParse(docToPreview(hit));
      if (parsed.success) out.push(parsed.data);
    }
    return out;
  }

  async stats(signal?: AbortSignal): Promise<CatalogStats> {
    let body: { facetDistribution?: { type?: Record<string, number> } };
    try {
      // limit:0 — we want only the facet counts, not documents.
      body = await this.req("POST", `/indexes/${this.index}/search`, { q: "", limit: 0, facets: ["type"] }, signal);
    } catch (err) {
      if (isIndexMissing(err)) return { artist: 0, album: 0, track: 0, total: 0 };
      throw err;
    }
    const dist = body.facetDistribution?.type ?? {};
    const artist = dist.artist ?? 0;
    const album = dist.album ?? 0;
    const track = dist.track ?? 0;
    return { artist, album, track, total: artist + album + track };
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

function docToPreview(d: CatalogDoc): unknown {
  // Albums get a deterministic Cover Art Archive poster from their release id
  // (the curated documents store none); other types keep whatever they carry.
  let poster = d.poster;
  if (!poster && d.type === "album") {
    const { uuid } = parseMbid(d.id);
    if (uuid) poster = releaseFrontCover(uuid);
  }
  return {
    type: d.type,
    id: d.id,
    name: d.name,
    ...(d.description ? { description: d.description } : {}),
    ...(poster ? { poster } : {}),
  };
}
