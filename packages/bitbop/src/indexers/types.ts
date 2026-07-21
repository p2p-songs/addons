/**
 * The discovery layer. Bitbop queries **the user's own** Torznab indexers
 * (Jackett / Prowlarr) — it ships no tracker list of its own. This is the same
 * "built-in discovery logic, user-supplied sources" shape as Torrentio, and the
 * distinction that keeps it in Torrentio's legal posture: the code knows *how*
 * to search, the config says *what* to search (Plan §3, Checklist §3).
 */

/** What we search an indexer for — derived from the recording's own metadata. */
export interface ReleaseQuery {
  artist: string;
  /** The release/album title to look for, when album context resolved one. */
  album?: string;
  /** The track/recording title, used when there is no album context. */
  track?: string;
}

/**
 * A discovered torrent — an *album* in the music case (Plan §2a). Bitbop holds
 * only this candidate metadata (title, infoHash, size); it never holds the
 * audio itself (Checklist §3).
 */
export interface TorrentCandidate {
  /** The indexer this came from (its config label / host). */
  indexer: string;
  /** Release/torrent display title, e.g. "Artist - Album (2013) [FLAC]". */
  title: string;
  /** 40-hex BitTorrent infohash, lowercased. The debrid provider resolves from this. */
  infoHash: string;
  /** Total size in bytes, when the indexer reports it. */
  sizeBytes?: number;
  /** Seeders, when reported — a coarse availability/quality signal for ranking. */
  seeders?: number;
  /** Container/codec label parsed from the title, e.g. "FLAC", "MP3". */
  format?: string;
}

/** A user-configured indexer Bitbop can query. Implementations are thin API adapters. */
export interface Indexer {
  /** Display label (config `name`, else the host). */
  readonly name: string;
  /**
   * Search for candidate releases. Network/HTTP failures should reject — the
   * resolver isolates per-indexer failures and distinguishes a total outage
   * from a genuine no-match (mirrors `stream-legal`, audit A-006).
   */
  search(query: ReleaseQuery, signal?: AbortSignal): Promise<TorrentCandidate[]>;
}
