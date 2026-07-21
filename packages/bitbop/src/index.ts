/**
 * @p2p-songs/bitbop — the `stream-debrid` reference addon (Plan §2). Turns torrent
 * bits into bops: discovers releases on the user's own indexers, selects the
 * right track file inside a whole-album torrent (Plan §2a), and resolves it
 * through the user's own debrid account to a direct link. One self-contained
 * addon in the Torrentio shape — no plugin interface, no operator account, no
 * stored audio.
 *
 * See `serve.ts` for the runnable entrypoint; this module is the library API.
 */
export { createBitbopAddon } from "./handler.js";
export type { BitbopDeps } from "./handler.js";
export { manifest } from "./manifest.js";
export { renderBitbopConfigurePage } from "./configure-page.js";

export { bitbopConfigSchema, parseConfig, redactConfig } from "./config.js";
export type { BitbopConfig, IndexerConfig, DebridProviderId } from "./config.js";

export { resolveStreams } from "./resolve.js";
export type { ResolveDeps, ResolveResult } from "./resolve.js";

export { MusicBrainzLookup } from "./metadata.js";
export type { MetadataLookup, TrackContext } from "./metadata.js";

export { TorznabIndexer, parseTorznab, buildQueryString } from "./indexers/torznab.js";
export type { Indexer, ReleaseQuery, TorrentCandidate } from "./indexers/types.js";

export { pickFile, parseFileNumbering, fuzzyScore } from "./pick-file.js";
export type { FileMatch } from "./pick-file.js";

export { createProvider, RealDebridProvider, DebridError } from "./debrid/index.js";
export type { DebridProvider, DebridFile, CacheResult, ResolvedLink } from "./debrid/index.js";

export { detectFormat, isAudioFile } from "./format.js";
