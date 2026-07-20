/**
 * Runnable entrypoint. Zero-config: wires the real MusicBrainz client and serves.
 *
 *   PORT=7002 node dist/serve.js
 *
 * MusicBrainz requires a descriptive User-Agent; set STREAM/META_USER_AGENT to
 * your own contact per their API policy before running against the live service.
 */
import { serveHTTP } from "@p2p-songs/addon-sdk";
import { MusicBrainzApi } from "@p2p-songs/musicbrainz";
import { createMusicMetaAddon } from "./handler.js";

const userAgent =
  process.env.MUSICMETA_USER_AGENT ??
  "p2p-songs-musicmeta/0.1.0 (https://github.com/p2p-songs/addons)";

const addon = createMusicMetaAddon({ mb: new MusicBrainzApi(userAgent) });

const port = Number(process.env.PORT ?? 7002);

serveHTTP(addon, {
  port,
  onError: (err) => console.error("[musicmeta]", err instanceof Error ? `${err.name}: ${err.message}` : err),
}).catch((err: unknown) => {
  console.error("[musicmeta] failed to start:", err);
  process.exitCode = 1;
});
