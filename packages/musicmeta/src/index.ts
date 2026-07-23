/**
 * @p2p-songs/musicmeta — MusicBrainz-backed catalog (search) + meta
 * (artist/album/track) with Cover Art Archive posters. The music Cinemeta.
 *
 * See `serve.ts` for the runnable entrypoint; this module is the library API.
 */
export { createMusicMetaAddon } from "./handler.js";
export type { MusicMetaDeps } from "./handler.js";
export { manifest } from "./manifest.js";
export { searchCatalog, DEFAULT_MIN_INDEX_HITS } from "./catalog.js";
export type { CatalogDeps } from "./catalog.js";
export { FakeSearchIndex, normalize } from "./search-index.js";
export type { SearchIndex } from "./search-index.js";
export { MeiliSearchIndex } from "./meili.js";
export type { MeiliOptions } from "./meili.js";
export { metaFor } from "./meta.js";
export type { MetaDeps } from "./meta.js";
export { releaseFrontCover, releaseGroupFrontCover } from "./coverart.js";
// The MusicBrainz client now lives in the shared @p2p-songs/musicbrainz package.
export { MusicBrainzApi } from "@p2p-songs/musicbrainz";
export type {
  MusicBrainzClient,
  MbArtist,
  MbRelease,
  MbAlbum,
  MbRecording,
  MbTrack,
  MbReleaseDetail,
} from "@p2p-songs/musicbrainz";
