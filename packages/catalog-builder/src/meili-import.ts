/**
 * Load a golden NDJSON dataset into Meilisearch with a **zero-downtime reindex**:
 * build a fresh staging index, then atomically swap it with the live one. Two
 * properties fall out of that:
 *
 * - The live index is never half-populated — readers see the old catalogue until
 *   the instant the complete new one is ready.
 * - Removals propagate. A merge-in-place would leave songs behind after an artist
 *   drops out of the curated set; a fresh index only ever contains current docs.
 *
 * The documents already carry `docId`, `searchtext`, etc. from the builder, so
 * this only creates the index, applies the search settings we validated, streams
 * the NDJSON in, and swaps.
 */

/**
 * The search settings validated against real data (see musicmeta `meili.ts`).
 *
 * `score` (the canonical dump's popularity/priority) is sortable and appended to
 * the ranking rules as a final tiebreaker: relevance still decides first, but
 * among equally-relevant hits the more popular one wins — so "justin bieber"
 * surfaces the popular artist and songs rather than an obscure like-named entry.
 */
const SETTINGS = {
  searchableAttributes: ["searchtext", "name", "description"],
  filterableAttributes: ["type"],
  sortableAttributes: ["score"],
  rankingRules: ["words", "typo", "proximity", "attribute", "sort", "exactness", "score:desc"],
};

export interface MeiliTarget {
  /** Base URL, e.g. `http://127.0.0.1:7700` or `http://meilisearch.railway.internal:7700`. */
  url: string;
  apiKey?: string;
  /** Live index name (default `catalog`). */
  index?: string;
  /** Bound on any single task wait, ms (default 10 min — a full import can be large). */
  taskTimeoutMs?: number;
}

export interface ImportResult {
  index: string;
  numberOfDocuments: number;
}

class Meili {
  private readonly base: string;
  private readonly headers: Record<string, string>;
  constructor(
    url: string,
    apiKey: string | undefined,
    private readonly taskTimeoutMs: number,
  ) {
    this.base = url.replace(/\/+$/, "");
    this.headers = apiKey ? { authorization: `Bearer ${apiKey}` } : {};
  }

  private async req<T>(method: string, path: string, body?: string, contentType?: string): Promise<T> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: { ...this.headers, ...(contentType ? { "content-type": contentType } : {}) },
      ...(body !== undefined ? { body } : {}),
    });
    if (!res.ok) throw new Error(`meili ${method} ${path} → ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return (await res.json()) as T;
  }

  async indexExists(uid: string): Promise<boolean> {
    const res = await fetch(`${this.base}/indexes/${uid}`, { headers: this.headers });
    if (res.status === 404) return false;
    if (!res.ok) throw new Error(`meili GET /indexes/${uid} → ${res.status}`);
    return true;
  }

  createIndex(uid: string): Promise<{ taskUid: number }> {
    return this.req("POST", "/indexes", JSON.stringify({ uid, primaryKey: "docId" }), "application/json");
  }
  deleteIndex(uid: string): Promise<{ taskUid: number }> {
    return this.req("DELETE", `/indexes/${uid}`);
  }
  updateSettings(uid: string): Promise<{ taskUid: number }> {
    return this.req("PATCH", `/indexes/${uid}/settings`, JSON.stringify(SETTINGS), "application/json");
  }
  addNdjson(uid: string, ndjson: string): Promise<{ taskUid: number }> {
    return this.req("POST", `/indexes/${uid}/documents`, ndjson, "application/x-ndjson");
  }
  swap(a: string, b: string): Promise<{ taskUid: number }> {
    return this.req("POST", "/swap-indexes", JSON.stringify([{ indexes: [a, b] }]), "application/json");
  }
  async stats(uid: string): Promise<ImportResult> {
    const s = await this.req<{ numberOfDocuments: number }>("GET", `/indexes/${uid}/stats`);
    return { index: uid, numberOfDocuments: s.numberOfDocuments };
  }

  async wait(taskUid: number): Promise<void> {
    const deadline = Date.now() + this.taskTimeoutMs;
    for (;;) {
      const t = await this.req<{ status: string; error?: { message?: string } }>("GET", `/tasks/${taskUid}`);
      if (t.status === "succeeded") return;
      if (t.status === "failed" || t.status === "canceled") {
        throw new Error(`meili task ${taskUid} ${t.status}: ${t.error?.message ?? ""}`);
      }
      if (Date.now() > deadline) throw new Error(`meili task ${taskUid} timed out`);
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

export async function importToMeili(
  target: MeiliTarget,
  ndjson: string,
  log: (msg: string) => void = () => {},
): Promise<ImportResult> {
  const index = target.index ?? "catalog";
  const staging = `${index}__staging`;
  const m = new Meili(target.url, target.apiKey, target.taskTimeoutMs ?? 600_000);

  // Fresh staging index (drop any leftover from a previous interrupted run).
  if (await m.indexExists(staging)) m.wait((await m.deleteIndex(staging)).taskUid).catch(() => {});
  log(`creating staging index ${staging}`);
  await m.wait((await m.createIndex(staging)).taskUid);
  await m.wait((await m.updateSettings(staging)).taskUid);
  log(`importing documents…`);
  await m.wait((await m.addNdjson(staging, ndjson)).taskUid);

  // Swap needs both indexes to exist; create the live one empty on first ever run.
  if (!(await m.indexExists(index))) await m.wait((await m.createIndex(index)).taskUid);
  log(`swapping ${staging} ⇄ ${index}`);
  await m.wait((await m.swap(staging, index)).taskUid);
  await m.wait((await m.deleteIndex(staging)).taskUid);

  return m.stats(index);
}
