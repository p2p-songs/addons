#!/usr/bin/env node
/**
 * catalog-builder CLI — publish/fetch versioned golden datasets to R2.
 *
 *   R2_ACCOUNT_ID=… R2_ACCESS_KEY_ID=… R2_SECRET_ACCESS_KEY=… \
 *     node dist/cli.js publish catalog.ndjson
 *
 * Credentials come from the environment, never the command line or the repo.
 * Commands:
 *   build <canonical.csv> [out.ndjson]  curate top-N-by-popularity from the
 *                                       MusicBrainz canonical dump → NDJSON
 *   publish <file.ndjson>   upload an immutable snapshot + repoint latest.json
 *   fetch [out.ndjson]      download latest, verify checksum, write it out
 *   import                  fetch latest from R2 → zero-downtime reindex into Meili
 *   versions                list snapshot keys, newest first
 *   rollback <key>          repoint latest.json at an existing snapshot
 */
import { readFileSync, writeFileSync } from "node:fs";
import { S3ObjectStore, FileObjectStore } from "./store.js";
import { publishDataset, fetchLatest, listVersions, rollbackTo, computeStats } from "./dataset.js";
import { importToMeili, type MeiliTarget } from "./meili-import.js";
import { buildCatalog } from "./build.js";
import { fetchTopArtists, fetchTopRecordings } from "./listenbrainz.js";

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
    case "build": {
      // Curate the golden NDJSON: ListenBrainz top artists (popularity scope) ⋈
      // a local MusicBrainz canonical-dump CSV (content). The Action extracts the
      // CSV first: `curl … | tar --zstd -x …`.
      if (!arg) throw new Error("usage: build <canonical_musicbrainz_data.csv> [out.ndjson]");
      const out = arg2 ?? "catalog.ndjson";
      const artistLimit = Number(process.env.CATALOG_ARTIST_LIMIT ?? 1000);
      const range = process.env.LISTENBRAINZ_RANGE ?? "all_time";
      console.error(`fetching top ${artistLimit.toLocaleString()} artists (ListenBrainz, ${range})…`);
      const artists = await fetchTopArtists({
        limit: artistLimit,
        range,
        ...(process.env.LISTENBRAINZ_URL ? { baseUrl: process.env.LISTENBRAINZ_URL } : {}),
        onProgress: (n) => console.error(`  ${n.toLocaleString()} artists`),
      });
      console.error(`fetching top recordings (per-song popularity boost)…`);
      const recordingPopularity = await fetchTopRecordings({
        limit: Number(process.env.CATALOG_RECORDING_LIMIT ?? 1000),
        range,
        ...(process.env.LISTENBRAINZ_URL ? { baseUrl: process.env.LISTENBRAINZ_URL } : {}),
      });
      console.error(
        `scoped to ${artists.size.toLocaleString()} artists (+${recordingPopularity.size.toLocaleString()} boosted songs); scanning ${arg}…`,
      );
      const ndjson = await buildCatalog(arg, {
        artists,
        recordingPopularity,
        onProgress: (n, kept) => console.error(`  scanned ${n.toLocaleString()} rows, kept ${kept.toLocaleString()}`),
      });
      writeFileSync(out, ndjson);
      const { records, counts } = computeStats(ndjson);
      console.error(`wrote ${out} — ${records.toLocaleString()} docs`, counts);
      break;
    }
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
      console.error("commands: build <csv> [out] | publish <file> | fetch [out] | import | versions | rollback <key>");
      process.exitCode = 1;
  }
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
}
