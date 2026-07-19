/**
 * @p2p-songs/musicmeta — MusicBrainz-backed catalog (search) + meta
 * (artist/album/track) with Cover Art Archive posters. The music Cinemeta.
 *
 * See `serve.ts` for the runnable entrypoint; this module is the library API.
 */
export { createMusicMetaAddon } from "./handler.js";
export type { MusicMetaDeps } from "./handler.js";
export { manifest } from "./manifest.js";
export { searchCatalog } from "./catalog.js";
export type { CatalogDeps } from "./catalog.js";
export { metaFor } from "./meta.js";
export type { MetaDeps } from "./meta.js";
export { MusicBrainzApi } from "./musicbrainz.js";
export type {
  MusicBrainzClient,
  MbArtist,
  MbRelease,
  MbRecording,
  MbTrack,
  MbReleaseDetail,
} from "./musicbrainz.js";
export { releaseFrontCover } from "./coverart.js";
