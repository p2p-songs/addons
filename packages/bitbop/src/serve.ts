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
import { MusicBrainzApi } from "@p2p-songs/musicbrainz";
import { createBitbopAddon } from "./handler.js";
import { renderBitbopConfigurePage } from "./configure-page.js";

const userAgent =
  process.env.BITBOP_USER_AGENT ?? "p2p-songs-bitbop/0.1.0 (https://github.com/p2p-songs/addons)";

const addon = createBitbopAddon({
  musicbrainz: new MusicBrainzApi(userAgent),
  // Redacted diagnostics only — never the raw error (it can quote a credential).
  onError: ({ message, config }) => console.error("[bitbop]", message, config),
});

const port = Number(process.env.PORT ?? 7003);

serveHTTP(addon, {
  port,
  configureHTML: renderBitbopConfigurePage,
  // Adapter-level failures: log the name only; the request path can carry the
  // config segment (the secret), so never log it (Checklist §7).
  onError: (err) => console.error("[bitbop]", err instanceof Error ? `${err.name}: ${err.message}` : "error"),
}).catch((err: unknown) => {
  console.error("[bitbop] failed to start:", err);
  process.exitCode = 1;
});
