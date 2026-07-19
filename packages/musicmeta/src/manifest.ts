import type { Manifest } from "@p2p-songs/addon-sdk";

/**
 * `musicmeta` manifest — the catalog + meta addon (the music equivalent of
 * Cinemeta). Search catalogs for songs/albums/artists, and full metadata for
 * any MusicBrainz entity id. Zero configuration.
 */
export const manifest: Manifest = {
  id: "com.p2p-songs.musicmeta",
  version: "0.1.0",
  name: "MusicMeta",
  description: "Music metadata and search, powered by MusicBrainz + Cover Art Archive.",
  resources: ["catalog", "meta"],
  types: ["artist", "album", "track"],
  idPrefixes: ["mbid:artist:", "mbid:release:", "mbid:recording:"],
  catalogs: [
    { type: "track", id: "search", name: "Songs", extra: [{ name: "search", isRequired: true }] },
    { type: "album", id: "search", name: "Albums", extra: [{ name: "search", isRequired: true }] },
    { type: "artist", id: "search", name: "Artists", extra: [{ name: "search", isRequired: true }] },
  ],
  behaviorHints: { p2p: false, configurable: false },
};
