/**
 * Versioned golden-dataset storage.
 *
 * Each build is written as an **immutable, timestamped** object under
 * `datasets/`, and a single `latest.json` manifest points at the current one.
 * We do our own versioning this way — not the bucket's native object versioning —
 * because a wholesale-rebuilt dataset wants human-readable, immutable snapshots,
 * and this scheme is portable to *any* S3-compatible provider (the whole point:
 * engine and provider stay disposable, the data is what we own).
 *
 * The manifest carries a **sha256** (a truncated/corrupt upload can never be
 * indexed — `fetchLatest` verifies before returning) and **per-type counts**,
 * which the addon surfaces so the player can show "X songs · Y albums · Z artists
 * indexed" and set the right expectation about catalogue scope.
 */
import { createHash } from "node:crypto";
import type { ObjectStore } from "./store.js";

export interface DatasetManifest {
  /** The immutable object this manifest points at, e.g. `datasets/catalog-2026-07-24_0300.ndjson`. */
  key: string;
  /** Total documents (non-empty lines). */
  records: number;
  /** Documents by `type` — `{ artist, album, track }`. */
  counts: Record<string, number>;
  /** sha256 of the NDJSON bytes; verified on fetch. */
  sha256: string;
  /** ISO-8601 build time. */
  builtAt: string;
}

export const MANIFEST_KEY = "latest.json";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/** Records, per-type counts, and checksum for an NDJSON dataset. */
export function computeStats(ndjson: string): Pick<DatasetManifest, "records" | "counts" | "sha256"> {
  const counts: Record<string, number> = {};
  let records = 0;
  for (const line of ndjson.split("\n")) {
    if (line.trim().length === 0) continue;
    records++;
    const type = (JSON.parse(line) as { type?: string }).type ?? "unknown";
    counts[type] = (counts[type] ?? 0) + 1;
  }
  return { records, counts, sha256: sha256Hex(ndjson) };
}

/** `datasets/catalog-<YYYY-MM-DD_HHMM>.ndjson` — sortable, immutable per build. */
export function datedKey(now: Date): string {
  const iso = now.toISOString();
  return `datasets/catalog-${iso.slice(0, 10)}_${iso.slice(11, 13)}${iso.slice(14, 16)}.ndjson`;
}

/** Upload an immutable snapshot and repoint `latest.json` at it. */
export async function publishDataset(store: ObjectStore, ndjson: string, now = new Date()): Promise<DatasetManifest> {
  const key = datedKey(now);
  await store.put(key, encoder.encode(ndjson), "application/x-ndjson");
  const manifest: DatasetManifest = { key, ...computeStats(ndjson), builtAt: now.toISOString() };
  await store.put(MANIFEST_KEY, encoder.encode(JSON.stringify(manifest, null, 2)), "application/json");
  return manifest;
}

/** Read `latest.json`, download the snapshot it names, and verify its checksum. */
export async function fetchLatest(store: ObjectStore): Promise<{ manifest: DatasetManifest; ndjson: string }> {
  const manifest = JSON.parse(decoder.decode(await store.get(MANIFEST_KEY))) as DatasetManifest;
  const ndjson = decoder.decode(await store.get(manifest.key));
  const actual = sha256Hex(ndjson);
  if (actual !== manifest.sha256) {
    throw new Error(`checksum mismatch for ${manifest.key}: manifest ${manifest.sha256}, got ${actual}`);
  }
  return { manifest, ndjson };
}

/** Snapshot keys, newest first. */
export async function listVersions(store: ObjectStore): Promise<string[]> {
  return (await store.list("datasets/")).sort().reverse();
}

/** Repoint `latest.json` at an existing snapshot (rollback), re-verifying its stats. */
export async function rollbackTo(store: ObjectStore, key: string, now = new Date()): Promise<DatasetManifest> {
  const ndjson = decoder.decode(await store.get(key));
  const manifest: DatasetManifest = { key, ...computeStats(ndjson), builtAt: now.toISOString() };
  await store.put(MANIFEST_KEY, encoder.encode(JSON.stringify(manifest, null, 2)), "application/json");
  return manifest;
}
