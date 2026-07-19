import type { Manifest } from "@p2p-songs/addon-sdk";

/**
 * `stream-legal` manifest. A zero-config stream-only addon: given a recording,
 * it returns direct URLs from Creative-Commons / public-domain catalogs. No
 * `/configure`, no credentials, no album file-selection (these are single-track
 * catalog files, not album torrents).
 */
export const manifest: Manifest = {
  id: "com.p2p-songs.stream-legal",
  version: "0.1.0",
  name: "Legal Streams",
  description:
    "Direct streams from Creative-Commons & public-domain catalogs (Internet Archive, optional Jamendo). Zero configuration.",
  resources: ["stream"],
  types: ["track"],
  idPrefixes: ["mbid:recording:"],
  catalogs: [],
  behaviorHints: { p2p: false, configurable: false },
};
