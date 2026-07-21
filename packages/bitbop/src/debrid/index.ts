/**
 * Debrid provider registry. Maps a config `provider` id to its adapter. Adding a
 * provider is one entry here plus a {@link DebridProvider} implementation — the
 * rest of Bitbop is provider-agnostic.
 */
import type { DebridProviderId } from "../config.js";
import type { DebridProvider } from "./types.js";
import { RealDebridProvider } from "./realdebrid.js";

export type { DebridProvider, DebridFile, CacheResult, ResolvedLink } from "./types.js";
export { DebridError } from "./types.js";
export { RealDebridProvider } from "./realdebrid.js";

export interface ProviderOptions {
  fetchImpl?: typeof fetch;
}

/**
 * Build the adapter for a configured provider. Returns `undefined` for a
 * provider we don't yet support (AllDebrid is in the config enum for the
 * `/configure` UI but has no adapter yet) — the handler turns that into an
 * empty result rather than a crash.
 */
export function createProvider(id: DebridProviderId, options: ProviderOptions = {}): DebridProvider | undefined {
  switch (id) {
    case "realdebrid":
      return new RealDebridProvider(options);
    case "alldebrid":
      return undefined; // not yet implemented
    default:
      return undefined;
  }
}
