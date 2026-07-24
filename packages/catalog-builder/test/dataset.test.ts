import { describe, expect, it } from "vitest";
import type { ObjectStore } from "../src/store.js";
import {
  MANIFEST_KEY,
  computeStats,
  datedKey,
  fetchLatest,
  listVersions,
  publishDataset,
  rollbackTo,
} from "../src/dataset.js";

/** In-memory {@link ObjectStore} so the dataset logic needs no real R2. */
class FakeStore implements ObjectStore {
  readonly objects = new Map<string, Uint8Array>();
  async put(key: string, body: Uint8Array): Promise<void> {
    this.objects.set(key, body);
  }
  async get(key: string): Promise<Uint8Array> {
    const v = this.objects.get(key);
    if (!v) throw new Error(`no such key: ${key}`);
    return v;
  }
  async list(prefix: string): Promise<string[]> {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
}

const ndjson =
  [
    { docId: "a", type: "artist", name: "Daft Punk" },
    { docId: "b", type: "album", name: "Discovery" },
    { docId: "c", type: "track", name: "One More Time" },
    { docId: "d", type: "track", name: "Aerodynamic" },
  ]
    .map((d) => JSON.stringify(d))
    .join("\n") + "\n";

describe("golden dataset storage", () => {
  it("computes records, per-type counts and a checksum", () => {
    const s = computeStats(ndjson);
    expect(s.records).toBe(4);
    expect(s.counts).toEqual({ artist: 1, album: 1, track: 2 });
    expect(s.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("publish writes an immutable snapshot + a latest.json pointing at it", async () => {
    const store = new FakeStore();
    const now = new Date("2026-07-24T03:00:00.000Z");
    const manifest = await publishDataset(store, ndjson, now);

    expect(manifest.key).toBe("datasets/catalog-2026-07-24_0300.ndjson");
    expect(manifest.counts).toEqual({ artist: 1, album: 1, track: 2 });
    expect(store.objects.has(manifest.key)).toBe(true);
    expect(store.objects.has(MANIFEST_KEY)).toBe(true);
  });

  it("fetchLatest round-trips through the manifest and verifies the checksum", async () => {
    const store = new FakeStore();
    await publishDataset(store, ndjson, new Date("2026-07-24T03:00:00Z"));

    const { manifest, ndjson: got } = await fetchLatest(store);
    expect(got).toBe(ndjson);
    expect(manifest.records).toBe(4);
  });

  it("rejects a corrupted snapshot instead of returning it", async () => {
    const store = new FakeStore();
    const manifest = await publishDataset(store, ndjson, new Date("2026-07-24T03:00:00Z"));
    // Corrupt the snapshot bytes but leave the manifest (and its sha256) intact.
    store.objects.set(manifest.key, new TextEncoder().encode(ndjson + '{"docId":"x"}\n'));

    await expect(fetchLatest(store)).rejects.toThrow(/checksum mismatch/);
  });

  it("lists versions newest-first and can roll back the pointer", async () => {
    const store = new FakeStore();
    await publishDataset(store, ndjson, new Date("2026-07-23T03:00:00Z"));
    await publishDataset(store, ndjson, new Date("2026-07-24T03:00:00Z"));

    const versions = await listVersions(store);
    expect(versions[0]).toBe("datasets/catalog-2026-07-24_0300.ndjson");
    expect(versions[1]).toBe("datasets/catalog-2026-07-23_0300.ndjson");

    const older = versions[1]!;
    const manifest = await rollbackTo(store, older);
    expect(manifest.key).toBe(older);
    expect((await fetchLatest(store)).manifest.key).toBe(older);
  });

  it("datedKey is sortable and immutable per minute", () => {
    expect(datedKey(new Date("2026-01-02T09:05:00Z"))).toBe("datasets/catalog-2026-01-02_0905.ndjson");
  });
});
