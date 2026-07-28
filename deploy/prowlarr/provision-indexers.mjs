#!/usr/bin/env node
// Provision the p2p-songs public indexer set into a Prowlarr instance.
//
//   PROWLARR_URL=https://prowlarr-xxx.up.railway.app \
//   PROWLARR_KEY=<the instance's API key> \
//   node provision-indexers.mjs
//
// Idempotent-ish: it skips any indexer already present by name. A fresh Prowlarr
// mints its own API key (Settings → General → Security), which is why we
// re-provision rather than migrate the DB. Run it against the hosted Prowlarr
// after first-boot setup; then regenerate the bitbop install URL with this
// PROWLARR_URL + PROWLARR_KEY.
//
// These are the six that worked locally. 1337x is intentionally absent: it sits
// behind CloudFlare and needs a FlareSolverr proxy (add that service first if you
// want it). TorrentGalaxy/Torlock aren't in the bundled Cardigann definitions.

const URL_BASE = (process.env.PROWLARR_URL || "").replace(/\/$/, "");
const KEY = process.env.PROWLARR_KEY;
if (!URL_BASE || !KEY) {
  console.error("Set PROWLARR_URL and PROWLARR_KEY.");
  process.exit(1);
}

const WANT = ["The Pirate Bay", "Knaben", "TorrentsCSV", "LimeTorrents", "Torrent Downloads", "MixtapeTorrent"];

const api = (path, init) =>
  fetch(`${URL_BASE}/api/v1${path}${path.includes("?") ? "&" : "?"}apikey=${KEY}`, init);

const existing = new Set((await (await api("/indexer")).json()).map((i) => i.name));
const schema = await (await api("/indexer/schema")).json();
const byName = Object.fromEntries(schema.map((s) => [s.name, s]));

for (const name of WANT) {
  if (existing.has(name)) {
    console.log(`  skip  ${name} (already present)`);
    continue;
  }
  const s = byName[name];
  if (!s) {
    console.log(`  MISS  ${name} (no definition on this Prowlarr)`);
    continue;
  }
  const body = { ...s, enable: true, appProfileId: 1 };
  const res = await api("/indexer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 200 || res.status === 201) {
    console.log(`  ADD   ${name}`);
  } else {
    console.log(`  FAIL  ${name} (HTTP ${res.status})  ${(await res.text()).slice(0, 200)}`);
  }
}

// Print the per-indexer Torznab base URLs bitbop needs (id-based).
const after = await (await api("/indexer")).json();
console.log("\nTorznab endpoints for the bitbop config (apiKey = this Prowlarr key):");
for (const i of after.sort((a, b) => a.id - b.id)) {
  console.log(`  ${URL_BASE}/${i.id}/api   # ${i.name}`);
}
