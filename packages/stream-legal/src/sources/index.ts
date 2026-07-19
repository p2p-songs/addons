/**
 * The **fixed source allowlist**. `stream-legal` searches only the sources this
 * factory returns; there is no mechanism to inject a source from a request, so
 * the addon can never be pointed at an arbitrary catalog (Review Checklist §5).
 * (Free Music Archive retired its public API, so it is intentionally not wired
 * up; add it here if/when a stable endpoint returns.)
 */
import type { LegalSource } from "./types.js";
import { InternetArchiveSource } from "./internet-archive.js";
import { JamendoSource } from "./jamendo.js";

export interface BuildSourcesOptions {
  fetchImpl?: typeof fetch;
  /** Operator app credential; when present, Jamendo joins the allowlist. */
  jamendoClientId?: string | undefined;
}

export function buildSources(options: BuildSourcesOptions = {}): LegalSource[] {
  const fetchImpl = options.fetchImpl ?? fetch;
  const sources: LegalSource[] = [new InternetArchiveSource(fetchImpl)];
  if (options.jamendoClientId) sources.push(new JamendoSource(options.jamendoClientId, fetchImpl));
  return sources;
}

export { InternetArchiveSource } from "./internet-archive.js";
export { JamendoSource } from "./jamendo.js";
export type { LegalSource, Candidate, TrackQuery } from "./types.js";
