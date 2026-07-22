/**
 * Destination-address policy for outbound indexer requests (audit A-011).
 *
 * Bitbop fetches a **caller-supplied** URL server-side. On a publicly reachable
 * deployment that is textbook SSRF: anyone who can reach the instance can encode
 * `http://169.254.169.254/…` (cloud metadata) or `http://127.0.0.1:…` into a
 * configured manifest and make the server request it. This module is the
 * allow/deny decision, kept pure so every range is directly testable.
 *
 * The subtlety that makes this a *policy* rather than a flat blocklist: a
 * **self-hosted** Bitbop is the normal case, and a self-hoster's Jackett or
 * Prowlarr usually lives at `http://localhost:9117` or on a LAN address. Denying
 * private destinations outright would break the primary use case. So there are
 * two modes, and the safe one is the default (see `guarded-fetch.ts`).
 */

/** Is this a normal, publicly-routable destination? `false` ⇒ deny in public mode. */
export function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false; // unknown family → deny
}

function ipv4Octets(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4) return undefined;
  // Plain decimal only. `Number()` alone would read "0x7f" as 127 and "1e2" as
  // 100, so a hostile spelling could reach a range check by a route the tests
  // don't cover. Anything else is undefined ⇒ denied.
  if (parts.some((p) => !/^\d{1,3}$/.test(p))) return undefined;
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => n > 255)) return undefined;
  return octets;
}

function isPublicIpv4(address: string): boolean {
  const o = ipv4Octets(address);
  if (!o) return false;
  const [a, b, c] = o as [number, number, number, number];

  if (a === 0) return false; // 0.0.0.0/8 "this network"
  if (a === 10) return false; // private
  if (a === 127) return false; // loopback
  if (a === 100 && b >= 64 && b <= 127) return false; // 100.64/10 CGNAT
  if (a === 169 && b === 254) return false; // link-local (cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return false; // private
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast
  if (a === 192 && b === 168) return false; // private
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast (224/4) + reserved/broadcast (240/4, 255.255.255.255)
  return true;
}

/**
 * Parse an IPv6 literal into its eight 16-bit words, or `undefined` if the text
 * isn't well-formed IPv6 — which callers treat as "deny".
 *
 * We classify on the **numbers**, never on the text, because one address has
 * many spellings and the interesting ones are chosen by an attacker.
 * `::ffff:127.0.0.1`, `::ffff:7f00:1` and `0:0:0:0:0:ffff:7f00:1` are the same
 * 128 bits; a prefix regex sees three unrelated strings.
 */
function ipv6Words(address: string): number[] | undefined {
  const halves = address.split("::");
  if (halves.length > 2) return undefined; // "::" may appear at most once

  const head = ipv6Groups(halves[0]!);
  const tail = halves.length === 2 ? ipv6Groups(halves[1]!) : [];
  if (!head || !tail) return undefined;

  if (halves.length === 1) return head.length === 8 ? head : undefined;
  const gap = 8 - head.length - tail.length;
  if (gap < 1) return undefined; // "::" must stand for at least one zero word
  return [...head, ...(Array<number>(gap).fill(0) as number[]), ...tail];
}

/** One colon-separated run of hex groups; its last group may be a dotted quad. */
function ipv6Groups(text: string): number[] | undefined {
  if (text === "") return [];
  const parts = text.split(":");
  const words: number[] = [];
  for (const [i, part] of parts.entries()) {
    if (i === parts.length - 1 && part.includes(".")) {
      const quad = ipv4Octets(part);
      if (!quad) return undefined;
      words.push((quad[0]! << 8) | quad[1]!, (quad[2]! << 8) | quad[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
    words.push(Number.parseInt(part, 16));
  }
  return words;
}

/** The v4 destination carried in the low 32 bits, judged as the v4 address it is. */
function embeddedIpv4IsPublic(w: number[]): boolean {
  const [hi, lo] = [w[6]!, w[7]!];
  return isPublicIpv4([hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join("."));
}

function isPublicIpv6(address: string): boolean {
  const w = ipv6Words(address.toLowerCase().split("%")[0]!); // drop any zone index
  if (!w) return false; // unparseable → deny

  const topIsZero = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0;
  if (topIsZero) {
    // ::/96 — unspecified, loopback, and IPv4-compatible (`::1.2.3.4`).
    if (w[4] === 0 && w[5] === 0) {
      if (w[6] === 0 && w[7]! <= 1) return false; // :: and ::1
      return embeddedIpv4IsPublic(w);
    }
    // Both v4-in-v6 forms reach a v4 host, so both are judged as that host:
    // ::ffff:0:0/96 (mapped) and ::ffff:0:0:0/96 (translated).
    if ((w[4] === 0 && w[5] === 0xffff) || (w[4] === 0xffff && w[5] === 0)) {
      return embeddedIpv4IsPublic(w);
    }
  }

  if ((w[0]! & 0xfe00) === 0xfc00) return false; // fc00::/7 unique-local
  if ((w[0]! & 0xffc0) === 0xfe80) return false; // fe80::/10 link-local
  if ((w[0]! & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (w[0] === 0x0064 && w[1] === 0xff9b) return false; // NAT64 → can reach v4 private space
  if (w[0] === 0x2001 && w[1] === 0x0db8) return false; // documentation
  if (w[0] === 0x2002) return false; // 6to4 — embeds an arbitrary v4 destination
  return true;
}

/** Schemes we will ever fetch. `http` is only reachable in private/self-host mode. */
export function isAllowedScheme(protocol: string, allowPrivate: boolean): boolean {
  if (protocol === "https:") return true;
  return protocol === "http:" && allowPrivate;
}
