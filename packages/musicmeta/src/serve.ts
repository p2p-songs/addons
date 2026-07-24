/**
 * Runnable entrypoint. Zero-config by default: wires the real MusicBrainz client
 * and serves.
 *
 *   PORT=7002 node dist/serve.js
 *
 * MusicBrainz requires a descriptive User-Agent; set STREAM/META_USER_AGENT to
 * your own contact per their API policy before running against the live service.
 *
 * **Optional search accelerator.** Set `MEILI_URL` (and `MEILI_API_KEY` if the
 * instance is secured) to put a Meilisearch index in front of catalog search —
 * ranked, typo-tolerant, self-warming. Unset, catalog search is direct
 * MusicBrainz exactly as before; the index is never a required dependency.
 *
 * **Binding.** Defaults to `127.0.0.1` — safe for local runs. In a container
 * (Railway/Fly/GCE), the platform routes to the pod's own interface, so set
 * `HOST=0.0.0.0`. `PORT` is honoured either way (platforms inject it).
 */
import { serveHTTP } from "@p2p-songs/addon-sdk";
import { MusicBrainzApi, CachedMusicBrainz } from "@p2p-songs/musicbrainz";
import { createMusicMetaAddon } from "./handler.js";
import { MeiliSearchIndex } from "./meili.js";

const userAgent =
  process.env.MUSICMETA_USER_AGENT ??
  "p2p-songs-musicmeta/0.1.0 (https://github.com/p2p-songs/addons)";

const meiliUrl = process.env.MEILI_URL;
const index = meiliUrl
  ? new MeiliSearchIndex({
      url: meiliUrl,
      ...(process.env.MEILI_API_KEY ? { apiKey: process.env.MEILI_API_KEY } : {}),
      ...(process.env.MEILI_INDEX ? { indexName: process.env.MEILI_INDEX } : {}),
    })
  : undefined;
if (index) console.error(`[musicmeta] search index: Meilisearch at ${meiliUrl}`);

const addon = createMusicMetaAddon({
  mb: new CachedMusicBrainz(new MusicBrainzApi(userAgent)),
  ...(index ? { index } : {}),
});

const port = Number(process.env.PORT ?? 7002);
const hostname = process.env.HOST ?? "127.0.0.1";

serveHTTP(addon, {
  port,
  hostname,
  onError: (err) => console.error("[musicmeta]", err instanceof Error ? `${err.name}: ${err.message}` : err),
}).catch((err: unknown) => {
  console.error("[musicmeta] failed to start:", err);
  process.exitCode = 1;
});
