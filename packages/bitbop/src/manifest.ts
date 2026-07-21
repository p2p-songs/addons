import type { Manifest } from "@p2p-songs/addon-sdk";

/**
 * Bitbop's manifest — the `stream-debrid` reference addon (Plan §2).
 *
 * `configurationRequired: true` is the load-bearing flag: the SDK router refuses
 * every resource request that doesn't carry a validly-decoded config segment, so
 * a handler is never invoked without the caller's own credentials and there is
 * no path that could silently fall back to an operator account (Checklist §3,
 * §6a). It also makes the player show "Configure" instead of "Install".
 *
 * Note what is *absent*: no `catalog`, no `meta`. Bitbop is one self-contained
 * stream addon in the Torrentio shape — discovery, ranking, file selection, and
 * debrid resolution all internal — not a meta-layer that aggregates other
 * addons (Plan §2).
 */
export const manifest: Manifest = {
  id: "com.p2p-songs.bitbop",
  version: "0.1.0",
  name: "Bitbop",
  description:
    "Turns torrent bits into bops. Resolves a recording to a direct link using your own indexers and your own debrid account — Bitbop never stores audio and never uses an account but yours.",
  resources: ["stream"],
  types: ["track"],
  idPrefixes: ["mbid:recording:"],
  catalogs: [],
  behaviorHints: {
    /**
     * False: the player only ever receives a fully-resolved https `url`.
     * File selection and debrid resolution happen server-side, and no
     * `infoHash` is ever emitted (Plan §2a, §8).
     */
    p2p: false,
    configurable: true,
    configurationRequired: true,
  },
};
