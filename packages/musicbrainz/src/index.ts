/**
 * @p2p-songs/musicbrainz — a shared, rate-limited MusicBrainz client for the
 * reference addons. See `client.ts` for the API and rate-limit contract.
 */
export { MusicBrainzApi } from "./client.js";
export type {
  MusicBrainzClient,
  MusicBrainzApiOptions,
  MbArtist,
  MbRelease,
  MbRecording,
  MbTrack,
  MbReleaseDetail,
} from "./client.js";
export { RateLimiter } from "./rate-limit.js";
export type { Sleep } from "./rate-limit.js";
