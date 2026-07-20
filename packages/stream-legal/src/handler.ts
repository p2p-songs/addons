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
      const { streams, allSourcesFailed } = await resolveStreams(recordingId, deps);
      // Total upstream outage → throw (SDK returns an uncacheable 500), so a
      // transient outage never poisons caches with a 6-hour "no streams".
      if (allSourcesFailed) throw new Error("all stream sources failed");
      // Genuine no-match → cache briefly (catalogs may gain the track later).
      if (streams.length === 0) return { streams: [], cacheMaxAge: 300 };
      // Real results from these stable catalogs → cache generously.
      return { streams, cacheMaxAge: 6 * 3600, staleRevalidate: 24 * 3600 };
    })
    .getInterface();
}
