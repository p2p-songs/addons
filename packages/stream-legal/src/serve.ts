/**
 * Runnable entrypoint. `stream-legal` has no per-user configuration, so it just
 * wires the real MusicBrainz lookup + the fixed source allowlist and serves.
 *
 *   PORT=7001 JAMENDO_CLIENT_ID=… node dist/serve.js
 */
import { serveHTTP } from "@p2p-songs/addon-sdk";
import { createStreamLegalAddon } from "./handler.js";
import { MusicBrainzLookup } from "./metadata.js";
import { buildSources } from "./sources/index.js";

const userAgent =
  process.env.STREAM_LEGAL_USER_AGENT ??
  "p2p-songs-stream-legal/0.1.0 (https://github.com/p2p-songs/addons)";

const addon = createStreamLegalAddon({
  metadata: new MusicBrainzLookup(userAgent),
  sources: buildSources({ jamendoClientId: process.env.JAMENDO_CLIENT_ID }),
});

const port = Number(process.env.PORT ?? 7001);

serveHTTP(addon, {
  port,
  // No user secrets here (zero-config addon); log the error name only, defensively.
  onError: (err) => console.error("[stream-legal]", err instanceof Error ? `${err.name}: ${err.message}` : err),
}).catch((err: unknown) => {
  console.error("[stream-legal] failed to start:", err);
  process.exitCode = 1;
});
