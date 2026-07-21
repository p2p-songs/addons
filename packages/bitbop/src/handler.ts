/**
 * Wire the resolve pipeline into an SDK addon. This is where the per-request
 * credential boundary is realized: the handler reads the debrid key and indexer
 * keys **only** from `ctx.config` (the decoded `/configure` segment for *this*
 * request), builds the indexers and provider from them, and resolves. There is
 * no ambient credential and no shared client to fall back to (Plan §3,
 * Checklist §3, §6a).
 */
import { AddonBuilder, type AddonInterface, type StreamArgs } from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient } from "@p2p-songs/musicbrainz";
import { manifest } from "./manifest.js";
import { parseConfig, redactConfig, type BitbopConfig } from "./config.js";
import { MusicBrainzLookup, type MetadataLookup } from "./metadata.js";
import { TorznabIndexer } from "./indexers/torznab.js";
import type { Indexer } from "./indexers/types.js";
import { createProvider } from "./debrid/index.js";
import { createGuardedFetch } from "./net/guarded-fetch.js";
import { resolveStreams, type ResolveDeps } from "./resolve.js";

export interface BitbopDeps {
  /** Shared, rate-limited MusicBrainz client (metadata lookup). */
  musicbrainz: MusicBrainzClient;
  /**
   * Transport for **indexer** requests. Defaults to a {@link createGuardedFetch}
   * in public (safe) mode — indexer URLs come from the caller, so an unguarded
   * `fetch` here is SSRF (audit A-011). Injectable for tests.
   */
  fetchImpl?: typeof fetch;
  /**
   * Allow `http` and non-public indexer destinations. Off by default so a
   * public deployment can't become an SSRF proxy; self-hosters enable it
   * because their Jackett/Prowlarr is typically on loopback or a LAN address.
   * Ignored when `fetchImpl` is supplied.
   */
  allowPrivateIndexers?: boolean;
  /** Override metadata lookup (tests). */
  metadata?: MetadataLookup;
  /** Override indexer construction (tests). */
  buildIndexers?: (config: BitbopConfig) => Indexer[];
  /** Override the resolve deps entirely (tests). */
  buildResolveDeps?: (config: BitbopConfig) => ResolveDeps | undefined;
  /** Redacted diagnostics sink (never receives raw credentials). */
  onError?: (info: { message: string; config: Record<string, unknown> }) => void;
}

export function createBitbopAddon(deps: BitbopDeps): AddonInterface {
  // Indexer destinations are caller-supplied, so the default transport is the
  // guarded one (A-011). The debrid provider talks to a fixed, first-party API
  // host, so it keeps the plain global `fetch`.
  const indexerFetch =
    deps.fetchImpl ?? createGuardedFetch({ allowPrivate: deps.allowPrivateIndexers ?? false });

  const buildResolveDeps =
    deps.buildResolveDeps ??
    ((config: BitbopConfig): ResolveDeps | undefined => {
      const provider = createProvider(config.debrid.provider, { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });
      if (!provider) return undefined; // configured provider has no adapter yet
      const indexers = deps.buildIndexers
        ? deps.buildIndexers(config)
        : config.indexers.map((ix) => new TorznabIndexer(ix, { fetchImpl: indexerFetch }));
      const metadata = deps.metadata ?? new MusicBrainzLookup(deps.musicbrainz);
      return { metadata, indexers, provider };
    });

  return new AddonBuilder(manifest)
    .defineStreamHandler(async (args: StreamArgs) => {
      // configurationRequired makes the router reject a missing config with a 400
      // before we get here; this is defence in depth (never resolve without a key).
      const config = parseConfig(args.config);
      if (!config) return { streams: [], cacheMaxAge: 0 };

      const resolveDeps = buildResolveDeps(config);
      if (!resolveDeps) return { streams: [], cacheMaxAge: 300 };

      try {
        const { streams, outage } = await resolveStreams(
          { recordingId: args.recordingId, ...(args.trackId ? { trackId: args.trackId } : {}), ...(args.releaseId ? { releaseId: args.releaseId } : {}) },
          config,
          resolveDeps,
        );
        // Total outage → throw so the SDK returns an uncacheable 500 (a transient
        // failure never poisons a cache with a long-lived "no streams").
        if (outage) throw new Error("bitbop: upstream outage (indexers or debrid unavailable)");
        // Genuine no-match caches briefly; real results are memory-only on the
        // player side (bearer URLs), so keep the addon-side cache short too.
        if (streams.length === 0) return { streams: [], cacheMaxAge: 300 };
        return { streams, cacheMaxAge: 60 };
      } catch (error) {
        // Redact before the diagnostics hook ever sees it — the raw error can
        // quote a credential (Checklist §6a).
        deps.onError?.({ message: messageOf(error), config: redactConfig(config) });
        throw error; // let the SDK produce an opaque 500
      }
    })
    .getInterface();
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
