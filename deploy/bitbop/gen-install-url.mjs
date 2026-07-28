#!/usr/bin/env node
// Generate a bitbop install URL for a given deployment, pulling the indexer list
// straight from Prowlarr so it always matches what's actually configured.
//
//   RD_KEY=<real-debrid key> \
//   PROWLARR_URL=https://prowlarr-xxx.up.railway.app \
//   PROWLARR_KEY=<prowlarr api key> \
//   BITBOP_URL=https://bitbop-xxx.up.railway.app \
//   node gen-install-url.mjs
//
// The resulting URL embeds the RD key and the Prowlarr key, so it IS a secret —
// treat it like a password (this is the documented Shape-A "trust cost", and the
// whole basis of the shared-setup model: whoever you hand this URL to plays
// through THIS debrid account and THIS Prowlarr). Nothing is sent anywhere; the
// config is base64url-encoded locally.

const RD_KEY = process.env.RD_KEY;
const PROWLARR_URL = (process.env.PROWLARR_URL || "").replace(/\/$/, "");
const PROWLARR_KEY = process.env.PROWLARR_KEY;
const BITBOP_URL = (process.env.BITBOP_URL || "").replace(/\/$/, "");
const missing = ["RD_KEY", "PROWLARR_URL", "PROWLARR_KEY", "BITBOP_URL"].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Set: ${missing.join(", ")}`);
  process.exit(1);
}

const res = await fetch(`${PROWLARR_URL}/api/v1/indexer?apikey=${PROWLARR_KEY}`);
if (!res.ok) {
  console.error(`Prowlarr /api/v1/indexer -> HTTP ${res.status}. Check PROWLARR_URL/PROWLARR_KEY.`);
  process.exit(1);
}
const indexers = (await res.json())
  .sort((a, b) => a.id - b.id)
  .map((i) => ({ url: `${PROWLARR_URL}/${i.id}/api`, apiKey: PROWLARR_KEY, name: i.name }));

if (indexers.length === 0) {
  console.error("Prowlarr has no indexers — run provision-indexers.mjs first.");
  process.exit(1);
}

const config = {
  debrid: { provider: "realdebrid", apiKey: RD_KEY },
  indexers,
  downloadUncached: true,
  maxResults: 8,
};

const b64url = Buffer.from(JSON.stringify(config), "utf8")
  .toString("base64")
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=+$/, "");

console.log(`\n${BITBOP_URL}/${b64url}/manifest.json\n`);
console.log(`(${indexers.length} indexers: ${indexers.map((i) => i.name).join(", ")})`);
