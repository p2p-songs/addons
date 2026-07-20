/**
 * Per-item license validation (audit A-006). The addon presents itself as
 * serving Creative-Commons / public-domain audio, so it must **fail closed per
 * item**: a candidate is only emitted if its metadata carries a *recognized*
 * open-rights value. Source-level provenance (e.g. "it's on the Internet
 * Archive") is NOT sufficient — plenty of Archive items are all-rights-reserved.
 *
 * We recognize Creative Commons license URLs (any version) and a small set of
 * explicit public-domain markers. Anything absent, unknown, malformed, or
 * all-rights-reserved is rejected.
 */

/** A CC license or public-domain dedication URL, e.g. creativecommons.org/licenses/by/3.0/. */
const CC_URL_RE = /^https?:\/\/creativecommons\.org\/(licenses|publicdomain)\/[a-z0-9-]+(\/[0-9.]+)?\/?/i;

/** Explicit public-domain markers sometimes present as free text. */
const PUBLIC_DOMAIN_MARKERS = [
  "public domain",
  "publicdomain",
  "cc0",
  "pd",
  "no known copyright",
];

/**
 * Is this a recognized open (CC / public-domain) license value? Accepts a URL
 * or a short marker string. `undefined`/empty/unknown → `false` (fail closed).
 */
export function isRecognizedOpenLicense(license: string | undefined): boolean {
  if (!license) return false;
  const value = license.trim();
  if (!value) return false;
  if (CC_URL_RE.test(value)) return true;
  const lower = value.toLowerCase();
  return PUBLIC_DOMAIN_MARKERS.some((m) => lower === m || lower.includes(m));
}

/** A compact, display-friendly label for a recognized license (for the stream name). */
export function licenseLabel(license: string): string {
  const cc = /creativecommons\.org\/licenses\/([a-z-]+)\/([0-9.]+)/i.exec(license);
  if (cc) return `CC ${cc[1]!.toUpperCase()} ${cc[2]}`;
  if (/creativecommons\.org\/publicdomain\/zero/i.test(license)) return "CC0";
  if (/creativecommons\.org\/publicdomain/i.test(license)) return "Public Domain";
  return license; // already a short marker like "Public Domain" / "CC0"
}
