/**
 * The source layer. `stream-legal` only ever pulls from a **fixed, audited set**
 * of Creative-Commons / public-domain catalogs (Review Checklist §5). It is not
 * an open proxy: no code path takes an arbitrary caller-supplied URL and returns
 * it as a stream. Every candidate URL is constructed by a registered source from
 * that source's own API response, and points at that source's own CDN.
 */

/** What we look a track up by (derived from the recording's metadata, never from the caller). */
export interface TrackQuery {
  artist: string;
  title: string;
  /** Recording duration, if known — used to disambiguate matches. */
  durationMs?: number;
}

/** A candidate audio file found on a legal source. */
export interface Candidate {
  /** The source that produced this (its `LegalSource.id`). */
  source: string;
  title: string;
  artist: string;
  /** Direct, playable audio URL on the source's own infrastructure. MUST be https. */
  url: string;
  /** Container/codec label for display, e.g. "MP3", "FLAC", "OGG". */
  format?: string;
  durationMs?: number;
  /** Human-readable license, e.g. "CC BY 3.0", "Public Domain". */
  license?: string;
}

/** A legal catalog `stream-legal` can search. Implementations are thin API adapters. */
export interface LegalSource {
  /** Stable id, e.g. "internet-archive". */
  readonly id: string;
  /** Display name, e.g. "Internet Archive". */
  readonly name: string;
  /** Find candidate files matching the query. Network failures should reject (the resolver isolates them). */
  search(query: TrackQuery, signal?: AbortSignal): Promise<Candidate[]>;
}
