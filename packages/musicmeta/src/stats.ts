/**
 * The `/stats` endpoint — public catalogue counts for the player's awareness UI
 * ("X songs · Y albums · Z artists indexed"). It is not part of the Stremio
 * protocol, so it is served as an {@link ExtraRouteHandler} ahead of the addon
 * router (see `serve.ts`), and it carries permissive CORS because the player
 * fetches it cross-origin.
 *
 * It exposes only aggregate counts of public catalogue data — no credential, no
 * per-item detail — so bypassing the router's secret-bearing posture is safe.
 */
import type { ExtraRouteHandler } from "@p2p-songs/addon-sdk";
import type { SearchIndex } from "./search-index.js";

const HEADERS: Record<string, string> = {
  "Content-Type": "application/json; charset=utf-8",
  "Access-Control-Allow-Origin": "*",
  // Counts change only when a new dataset is imported (nightly); let the edge
  // cache it briefly so a popular player fleet doesn't stampede the endpoint.
  "Cache-Control": "public, max-age=300",
};

/**
 * Build the `/stats` handler. Without a configured index (a `MEILI_URL`-less dev
 * run) or when the index is unreachable, it responds `503` so the player simply
 * hides the indicator rather than showing a misleading zero.
 */
export function createStatsRoute(index?: SearchIndex): ExtraRouteHandler {
  return async () => {
    if (!index) {
      return { status: 503, headers: HEADERS, body: JSON.stringify({ error: "no catalogue index configured" }) };
    }
    try {
      const stats = await index.stats();
      return { status: 200, headers: HEADERS, body: JSON.stringify(stats) };
    } catch {
      return { status: 503, headers: HEADERS, body: JSON.stringify({ error: "catalogue index unavailable" }) };
    }
  };
}
