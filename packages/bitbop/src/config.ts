/**
 * Bitbop's per-install configuration — **the user's own credentials**, carried
 * in the manifest URL path and never stored by the addon (SDK `config.ts`,
 * Plan §3).
 *
 * Two legal invariants are enforced *here*, at the type level, rather than
 * being left to the call sites:
 *
 * - **There is no operator fallback.** {@link BitbopConfig} makes the debrid
 *   credential required, and the addon reads credentials from nowhere else —
 *   no environment variable, no default, no shared pool. A request without a
 *   valid config cannot be served, which is why the manifest sets
 *   `configurationRequired` and the router fails closed (Checklist §3, §6a).
 * - **The indexers are the user's own.** Bitbop ships discovery *logic*, not a
 *   built-in tracker list: every indexer URL comes from this config. Torrentio
 *   ships its own indexer list; we deliberately don't, because "built-in
 *   discovery" and "a hardcoded illicit source" are distinguishable only by
 *   who chose the source (Checklist §3).
 *
 * The whole object is secret-bearing. Never log it, never echo it in an error,
 * never include it in a cacheable response.
 */
import { z } from "zod";

/**
 * Debrid providers Bitbop can talk to. Adding one means implementing the
 * {@link import("./debrid/types.js").DebridProvider} port — the rest of the
 * pipeline is provider-agnostic.
 */
export const debridProviderIdSchema = z.enum(["realdebrid", "alldebrid"]);
export type DebridProviderId = z.infer<typeof debridProviderIdSchema>;

/**
 * A Torznab endpoint (Jackett / Prowlarr). `url` is the indexer's base Torznab
 * API URL; `apiKey` is that indexer's key. Both belong to the user.
 */
export const indexerConfigSchema = z.object({
  /** Torznab API endpoint, e.g. `https://jackett.example/api/v2.0/indexers/all/results/torznab`. */
  url: z.string().url(),
  apiKey: z.string().min(1),
  /** Display label; falls back to the URL's host. */
  name: z.string().optional(),
});
export type IndexerConfig = z.infer<typeof indexerConfigSchema>;

export const bitbopConfigSchema = z.object({
  debrid: z.object({
    provider: debridProviderIdSchema,
    /** The user's own API key for that provider. Required — there is no fallback. */
    apiKey: z.string().min(1),
  }),
  /** The user's own Torznab indexers. At least one, or discovery has nothing to query. */
  indexers: z.array(indexerConfigSchema).min(1),
  /**
   * Only return streams the debrid provider reports as **already cached**.
   * Default true: an uncached torrent would mean asking the provider to start a
   * download and polling for it, which is not a thing a player can wait on
   * mid-queue. See `resolve.ts`.
   */
  cachedOnly: z.boolean().default(true),
  /** Preferred audio formats, best first. Used for ranking only, never as a filter. */
  preferFormats: z.array(z.string()).default(["FLAC", "MP3"]),
  /** Cap on returned streams. */
  maxResults: z.number().int().positive().max(20).default(8),
});

export type BitbopConfig = z.infer<typeof bitbopConfigSchema>;

/**
 * Parse an unknown decoded config segment into a {@link BitbopConfig}.
 *
 * Returns `undefined` rather than throwing, and the caller turns that into a
 * flat 400 — a zod error message would quote the offending value, and the
 * offending value here can be the user's debrid key (Checklist §6a: error
 * bodies are opaque).
 */
export function parseConfig(raw: unknown): BitbopConfig | undefined {
  const result = bitbopConfigSchema.safeParse(raw);
  return result.success ? result.data : undefined;
}

/**
 * A redacted view of a config, safe for logs and diagnostics.
 *
 * The `onError` hook and any operator logging must go through this. It keeps
 * only shapes and counts — never key material, and never the indexer URLs
 * (which can themselves carry a key in a query string).
 */
export function redactConfig(config: BitbopConfig): Record<string, unknown> {
  return {
    debrid: { provider: config.debrid.provider, apiKey: "[redacted]" },
    indexers: config.indexers.map((i) => ({ name: i.name ?? hostOf(i.url), url: "[redacted]", apiKey: "[redacted]" })),
    cachedOnly: config.cachedOnly,
    preferFormats: config.preferFormats,
    maxResults: config.maxResults,
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "[invalid]";
  }
}
