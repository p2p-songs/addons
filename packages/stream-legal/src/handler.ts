/** Wire the resolve pipeline into an SDK addon interface. */
import { AddonBuilder, type AddonInterface } from "@p2p-songs/addon-sdk";
import { manifest } from "./manifest.js";
import { resolveStreams, type ResolveDeps } from "./resolve.js";

/**
 * Build the `stream-legal` addon. `deps` supplies the metadata lookup and the
 * fixed source allowlist (injected so the addon is testable without network).
 */
export function createStreamLegalAddon(deps: ResolveDeps): AddonInterface {
  return new AddonBuilder(manifest)
    .defineStreamHandler(async ({ recordingId }) => {
      const streams = await resolveStreams(recordingId, deps);
      // These catalogs are stable — cache generously; nothing here expires.
      return { streams, cacheMaxAge: 6 * 3600, staleRevalidate: 24 * 3600 };
    })
    .getInterface();
}
