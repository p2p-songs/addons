/**
 * Runnable entrypoint (Plan §10: `stream-debrid` runs as a small always-on Node
 * service — outbound calls to indexers + debrid APIs need a persistent process,
 * not a functions runtime).
 *
 *   PORT=7003 node dist/serve.js
 *
 * There are **no credential environment variables**, by design: Bitbop takes
 * the debrid key and indexers only from each request's own `/configure` config.
 * A deployer runs the service; each user brings their own account (Plan §3).
 */
import { serveHTTP } from "@p2p-songs/addon-sdk";
import { MusicBrainzApi, CachedMusicBrainz } from "@p2p-songs/musicbrainz";
import { createBitbopAddon } from "./handler.js";
import { renderBitbopConfigurePage } from "./configure-page.js";

const userAgent =
  process.env.BITBOP_USER_AGENT ?? "p2p-songs-bitbop/0.1.0 (https://github.com/p2p-songs/addons)";

/**
 * **Deployment mode (audit A-011).** Indexer URLs come from the caller, and this
 * service fetches them, so a public instance must refuse loopback/link-local/
 * private destinations or it is an SSRF proxy. That safe mode is the **default**.
 *
 * A self-hosted instance is the common case and its Jackett/Prowlarr usually
 * lives at `http://localhost:9117`, so self-hosters opt in explicitly:
 *
 *   BITBOP_ALLOW_PRIVATE_INDEXERS=1 node dist/serve.js
 *
 * Only ever set that on an instance **you alone can reach**.
 */
const allowPrivateIndexers = process.env.BITBOP_ALLOW_PRIVATE_INDEXERS === "1";

const addon = createBitbopAddon({
  // Cached: resolution is per track, so a 12-track album otherwise makes 12
  // identical release lookups — 12s of MusicBrainz's 1 req/sec budget per album.
  musicbrainz: new CachedMusicBrainz(new MusicBrainzApi(userAgent)),
  allowPrivateIndexers,
  // Redacted diagnostics only — never the raw error (it can quote a credential).
  onError: ({ message, config }) => console.error("[bitbop]", message, config),
});

const port = Number(process.env.PORT ?? 7003);

console.log(
  allowPrivateIndexers
    ? "[bitbop] indexer policy: PRIVATE ALLOWED (self-host mode) — do not expose this instance publicly"
    : "[bitbop] indexer policy: public-only (https, non-private destinations); set BITBOP_ALLOW_PRIVATE_INDEXERS=1 for a self-hosted indexer",
);

serveHTTP(addon, {
  port,
  // The page states this instance's indexer policy and pre-checks against it,
  // so a refused destination is caught at configure time (A-011).
  configureHTML: (ctx) => renderBitbopConfigurePage({ ...ctx, allowPrivateIndexers }),
  // Adapter-level failures: log the name only; the request path can carry the
  // config segment (the secret), so never log it (Checklist §7).
  onError: (err) => console.error("[bitbop]", err instanceof Error ? `${err.name}: ${err.message}` : "error"),
}).catch((err: unknown) => {
  console.error("[bitbop] failed to start:", err);
  process.exitCode = 1;
});
