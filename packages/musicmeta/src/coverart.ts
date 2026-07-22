/**
 * Cover Art Archive poster URLs. CAA exposes a stable per-release front-cover
 * endpoint that 302-redirects to the image, so we can build the URL from a
 * release MBID without an API call. https only (protocol requirement).
 */
const CAA_BASE = "https://coverartarchive.org";

/** Front cover for a release. `size` uses CAA's thumbnail suffixes. */
export function releaseFrontCover(releaseUuid: string, size: 250 | 500 | 1200 = 500): string {
  return `${CAA_BASE}/release/${releaseUuid}/front-${size}`;
}

/**
 * Front cover for a release *group*.
 *
 * Cover art is uploaded per release, so a given pressing may simply have none —
 * which is why a discography built on release ids shows occasional broken
 * thumbnails. The group endpoint falls back to whichever of its releases does
 * have art, so prefer it wherever the group id is known.
 */
export function releaseGroupFrontCover(groupUuid: string, size: 250 | 500 | 1200 = 500): string {
  return `${CAA_BASE}/release-group/${groupUuid}/front-${size}`;
}
