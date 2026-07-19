/**
 * @p2p-songs/stream-legal — a zero-config stream addon resolving recordings to
 * direct URLs from a fixed set of Creative-Commons / public-domain catalogs.
 *
 * See `serve.ts` for the runnable entrypoint; this module is the library API.
 */
export { createStreamLegalAddon } from "./handler.js";
export { manifest } from "./manifest.js";
export { resolveStreams } from "./resolve.js";
export type { ResolveDeps } from "./resolve.js";
export { MusicBrainzLookup } from "./metadata.js";
export type { MetadataLookup, RecordingMeta } from "./metadata.js";
export { buildSources, InternetArchiveSource, JamendoSource } from "./sources/index.js";
export type { BuildSourcesOptions } from "./sources/index.js";
export type { LegalSource, Candidate, TrackQuery } from "./sources/types.js";
export { scoreCandidate, rankCandidates, normalize, MATCH_THRESHOLD } from "./match.js";
