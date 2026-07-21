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
  const octets = parts.map((p) => Number(p));
  if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return undefined;
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

function isPublicIpv6(address: string): boolean {
  const addr = address.toLowerCase().split("%")[0]!; // drop any zone index

  // IPv4-mapped/compatible (::ffff:1.2.3.4, ::1.2.3.4) — judge the embedded v4.
  const mapped = /^::(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(addr);
  if (mapped) return isPublicIpv4(mapped[1]!);

  if (addr === "::" || addr === "::1") return false; // unspecified / loopback
  if (/^f[cd]/.test(addr)) return false; // fc00::/7 unique-local
  if (/^fe[89ab]/.test(addr)) return false; // fe80::/10 link-local
  if (/^ff/.test(addr)) return false; // ff00::/8 multicast
  if (addr.startsWith("64:ff9b:")) return false; // NAT64 → can reach v4 private space
  if (addr.startsWith("2001:db8:")) return false; // documentation
  if (addr.startsWith("2002:")) return false; // 6to4 — embeds an arbitrary v4 destination
  return true;
}

/** Schemes we will ever fetch. `http` is only reachable in private/self-host mode. */
export function isAllowedScheme(protocol: string, allowPrivate: boolean): boolean {
  if (protocol === "https:") return true;
  return protocol === "http:" && allowPrivate;
}
