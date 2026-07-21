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
 * Build the adapter for a configured provider.
 *
 * Every id the config schema accepts has an adapter here — an unimplemented
 * provider is kept out of the schema entirely rather than accepted and then
 * silently yielding nothing (audit A-011). The `undefined` return remains as
 * defence in depth for a schema/registry drift.
 */
export function createProvider(id: DebridProviderId, options: ProviderOptions = {}): DebridProvider | undefined {
  switch (id) {
    case "realdebrid":
      return new RealDebridProvider(options);
    default:
      return undefined;
  }
}
