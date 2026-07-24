#!/usr/bin/env node
/**
 * catalog-builder CLI — publish/fetch versioned golden datasets to R2.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *     node dist/cli.js publish catalog.ndjson
 *
 * Credentials come from the environment, never the command line or the repo.
 * Commands:
 *   publish <file.ndjson>   upload an immutable snapshot + repoint latest.json
 *   fetch [out.ndjson]      download latest, verify checksum, write it out
 *   versions                list snapshot keys, newest first
 *   rollback <key>          repoint latest.json at an existing snapshot
 */
import { readFileSync, writeFileSync } from "node:fs";
import { S3ObjectStore, FileObjectStore } from "./store.js";
import { publishDataset, fetchLatest, listVersions, rollbackTo } from "./dataset.js";
import { importToMeili, type MeiliTarget } from "./meili-import.js";

function meiliFromEnv(): MeiliTarget {
  const url = process.env.MEILI_URL;
  if (!url) throw new Error("set MEILI_URL [, MEILI_API_KEY, MEILI_INDEX=catalog]");
  return {
    url,
    ...(process.env.MEILI_API_KEY ? { apiKey: process.env.MEILI_API_KEY } : {}),
    ...(process.env.MEILI_INDEX ? { index: process.env.MEILI_INDEX } : {}),
  };
}

function storeFromEnv(): S3ObjectStore {
  const endpoint =
    process.env.R2_ENDPOINT ??
    (process.env.R2_ACCOUNT_ID
      ? `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`
      : undefined);
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET ?? "songs-catalog";
  if (!endpoint || !accessKeyId || !secretAccessKey) {
    throw new Error(
      "set R2_ENDPOINT (or R2_ACCOUNT_ID), R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY [, R2_BUCKET=songs-catalog]",
    );
  }
  return new S3ObjectStore({ endpoint, accessKeyId, secretAccessKey, bucket });
}

const [cmd, arg, arg2] = process.argv.slice(2);

try {
  switch (cmd) {
    case "publish": {
      if (!arg) throw new Error("usage: publish <file.ndjson>");
      const manifest = await publishDataset(storeFromEnv(), readFileSync(arg, "utf8"));
      console.error(`published ${manifest.key}`);
      console.error(JSON.stringify(manifest, null, 2));
      break;
    }
    case "stage": {
      // Write the versioned objects to a local dir (default ./r2-stage) for any
      // transport to upload. Same manifest/checksum logic as `publish`.
      if (!arg) throw new Error("usage: stage <file.ndjson> [outDir]");
      const dir = arg2 ?? "r2-stage";
      const manifest = await publishDataset(new FileObjectStore(dir), readFileSync(arg, "utf8"));
      console.error(`staged into ${dir}/`);
      console.error(`  ${manifest.key}`);
      console.error(`  latest.json  →  ${JSON.stringify(manifest.counts)}  (${manifest.records} docs)`);
      break;
    }
    case "fetch": {
      const out = arg ?? "catalog.ndjson";
      const { manifest, ndjson } = await fetchLatest(storeFromEnv());
      writeFileSync(out, ndjson);
      console.error(`fetched ${manifest.key} → ${out} (${manifest.records} docs)`, manifest.counts);
      break;
    }
    case "import": {
      // R2 → verify → zero-downtime reindex into Meili. Runs where it can reach
      // Meili (inside Railway in prod; against a local Meili for testing).
      const { manifest, ndjson } = await fetchLatest(storeFromEnv());
      console.error(`fetched ${manifest.key} (${manifest.records} docs)`, manifest.counts);
      const result = await importToMeili(meiliFromEnv(), ndjson, (m) => console.error(`  ${m}`));
      console.error(`indexed ${result.numberOfDocuments} docs into "${result.index}"`);
      break;
    }
    case "versions": {
      for (const key of await listVersions(storeFromEnv())) console.error(key);
      break;
    }
    case "rollback": {
      if (!arg) throw new Error("usage: rollback <datasets/…​.ndjson>");
      const manifest = await rollbackTo(storeFromEnv(), arg);
      console.error(`latest.json → ${manifest.key}`);
      break;
    }
    default:
      console.error("commands: publish <file> | fetch [out] | versions | rollback <key>");
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
