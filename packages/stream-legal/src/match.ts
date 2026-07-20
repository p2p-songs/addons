/**
 * Deterministic candidate matching/ranking. The source APIs are keyword search
 * engines, so a query for "Artist – Title" returns loosely-related items; this
 * module scores each candidate against the intended recording and drops weak
 * matches, so `stream-legal` doesn't serve an unrelated track. Pure and tested.
 */
import type { Candidate, TrackQuery } from "./sources/types.js";
import { isRecognizedOpenLicense } from "./license.js";

/** Lowercase, strip diacritics/punctuation, drop "feat." tails, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/\p{M}/gu, "") // strip combining diacritical marks
    .toLowerCase()
    .replace(/\(feat\.?[^)]*\)|\bfeat\.?\b.*$/g, " ") // featured-artist noise
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function tokens(s: string): Set<string> {
  return new Set(normalize(s).split(" ").filter(Boolean));
}

/** Jaccard overlap of token sets, 0..1. */
function tokenOverlap(a: string, b: string): number {
  const sa = tokens(a);
  const sb = tokens(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** String similarity that rewards exact and substring matches over mere token overlap. */
function stringScore(a: string, b: string): number {
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.85;
  return tokenOverlap(a, b);
}

/** Duration closeness in [0,1]: 1 when within ~2s, decaying to 0 by ~15s apart. */
function durationScore(queryMs: number | undefined, candidateMs: number | undefined): number {
  if (queryMs === undefined || candidateMs === undefined) return 0.5; // unknown → neutral
  const diff = Math.abs(queryMs - candidateMs);
  if (diff <= 2000) return 1;
  if (diff >= 15000) return 0;
  return 1 - (diff - 2000) / 13000;
}

/** Combined score in [0,1]. Title dominates, then artist, with duration as a tiebreaker. */
export function scoreCandidate(query: TrackQuery, c: Candidate): number {
  const title = stringScore(query.title, c.title);
  const artist = stringScore(query.artist, c.artist);
  const duration = durationScore(query.durationMs, c.durationMs);
  return 0.6 * title + 0.3 * artist + 0.1 * duration;
}

/** Below this, a candidate is considered an unrelated match and dropped. */
export const MATCH_THRESHOLD = 0.5;

/**
 * Minimum artist agreement required when both the query and candidate name an
 * artist. Without this, an exact title (0.6) + matching duration (0.1) clears
 * the threshold even with zero artist overlap — so a common title like "Home"
 * would resolve to a *different artist's* song (audit A-006). Duration is
 * corroboration only, never a substitute for artist agreement.
 */
export const MIN_ARTIST_SCORE = 0.4;

/** Does the candidate agree on artist well enough (when artist info exists on both sides)? */
function artistGate(query: TrackQuery, c: Candidate): boolean {
  if (!normalize(query.artist) || !normalize(c.artist)) return true; // unknown on either side → can't gate
  return stringScore(query.artist, c.artist) >= MIN_ARTIST_SCORE;
}

/**
 * Rank candidates. A candidate survives only if it: is an https URL; carries a
 * recognized open (CC / public-domain) license; agrees on artist (when known);
 * and scores at/above threshold. Then sort best-first and dedupe by URL.
 * Non-https and unlicensed candidates are dropped defensively so a misbehaving
 * source can't poison the response or overstate rights.
 */
export function rankCandidates(query: TrackQuery, candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  return candidates
    .filter((c) => /^https:\/\//i.test(c.url))
    .filter((c) => isRecognizedOpenLicense(c.license))
    .filter((c) => artistGate(query, c))
    .map((c) => ({ c, score: scoreCandidate(query, c) }))
    .filter(({ score }) => score >= MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .filter(({ c }) => (seen.has(c.url) ? false : (seen.add(c.url), true)))
    .map(({ c }) => c);
}
