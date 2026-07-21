/**
 * A `fetch`-shaped transport that refuses hostile destinations (audit A-011).
 *
 * Bitbop's indexer URL comes from the caller's `/configure` config, and a
 * publicly-hosted instance will fetch it server-side — SSRF unless the
 * destination is policed. Three things have to hold, and the third is the one
 * that's easy to get wrong:
 *
 *  1. **Scheme policy** — `https` only in public mode.
 *  2. **Redirects are re-validated per hop.** `fetch` follows redirects by
 *     default, so a permitted public URL that 302s to `http://127.0.0.1` would
 *     sail straight through a naive pre-flight check. We follow manually and
 *     apply the full policy to every hop.
 *  3. **The address we validate is the address we connect to.** Checking DNS and
 *     *then* letting the HTTP stack resolve again leaves a DNS-rebinding window
 *     (first answer public, second answer loopback). This is built on
 *     `node:http`'s `lookup` hook precisely so the validated address is handed
 *     directly to the socket — one resolution, no TOCTOU gap.
 *
 * It is deliberately `fetch`-shaped so `TorznabIndexer` keeps its injectable
 * seam and stays testable with a plain fake.
 */
import { request as httpRequest, type RequestOptions } from "node:http";
import { request as httpsRequest } from "node:https";
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { isAllowedScheme, isPublicAddress } from "./ip-policy.js";

export interface GuardedFetchOptions {
  /**
   * Allow `http` and non-public destinations. **Off by default**: the safe mode
   * is the default so a public deployment is not one forgotten env var away
   * from being an SSRF proxy. Self-hosters turn it on (their Jackett is
   * typically `http://localhost:9117`).
   */
  allowPrivate?: boolean;
  /** Redirect hops to follow before giving up. */
  maxRedirects?: number;
  /** Cap on the response body we will buffer (Torznab XML; guards a hostile endpoint). */
  maxBodyBytes?: number;
}

/** Thrown when a destination is refused. Carries no URL — the URL holds an indexer key. */
export class BlockedDestinationError extends Error {
  constructor(reason: string) {
    super(`blocked destination: ${reason}`);
    this.name = "BlockedDestinationError";
  }
}

const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BODY_BYTES = 8 * 1024 * 1024;

export function createGuardedFetch(options: GuardedFetchOptions = {}): typeof fetch {
  const allowPrivate = options.allowPrivate ?? false;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;

  const guarded = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    let url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const signal = init?.signal ?? undefined;

    for (let hop = 0; ; hop++) {
      if (!isAllowedScheme(url.protocol, allowPrivate)) {
        throw new BlockedDestinationError(
          url.protocol === "http:" ? "http is not permitted in public mode" : `scheme ${url.protocol}`,
        );
      }
      // A **literal IP host never triggers DNS**, so the `lookup` hook below
      // would never run and the address would go unchecked. Validate it here.
      // (Found by the loopback/metadata regression tests, not by inspection.)
      assertLiteralHostAllowed(url.hostname, allowPrivate);

      const res = await once(url, init, signal, allowPrivate, maxBodyBytes);
      if (!isRedirect(res.status) || !res.location) {
        return new Response(res.body, { status: res.status, headers: res.headers });
      }
      if (hop >= maxRedirects) throw new BlockedDestinationError("too many redirects");
      // Re-validate the next hop under the full policy (this is the step a
      // pre-flight-only check misses).
      url = new URL(res.location, url);
    }
  };

  return guarded as typeof fetch;
}

interface RawResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
  location?: string;
}

/**
 * Validate a hostname that is already a literal IP. Node connects straight to a
 * numeric host without consulting `dns.lookup`, so the socket-level hook can't
 * see it — this is the other half of the address policy, not a redundant check.
 */
function assertLiteralHostAllowed(hostname: string, allowPrivate: boolean): void {
  if (allowPrivate) return;
  // URL keeps IPv6 hosts bracketed; `isIP` wants them bare.
  const bare = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  const family = isIP(bare);
  if (family === 0) return; // a name, not a literal — the lookup hook covers it
  if (!isPublicAddress(bare, family)) throw new BlockedDestinationError("non-public address");
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function once(
  url: URL,
  init: RequestInit | undefined,
  signal: AbortSignal | undefined,
  allowPrivate: boolean,
  maxBodyBytes: number,
): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());

    const opts: RequestOptions = {
      method: init?.method ?? "GET",
      headers: toHeaderRecord(init?.headers),
      // The whole point: the socket connects to the address we validated.
      lookup: guardedLookup(allowPrivate),
    };

    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(url, opts, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > maxBodyBytes) {
          req.destroy();
          reject(new BlockedDestinationError("response body exceeded limit"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        const location = res.headers.location;
        resolve({
          status: res.statusCode ?? 0,
          headers: flattenHeaders(res.headers),
          body: Buffer.concat(chunks),
          ...(typeof location === "string" ? { location } : {}),
        });
      });
      res.on("error", reject);
    });

    const onAbort = (): void => {
      req.destroy();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    req.on("error", (err) => reject(err));
    req.on("close", () => signal?.removeEventListener("abort", onAbort));

    if (init?.body && typeof init.body === "string") req.write(init.body);
    req.end();
  });
}

/**
 * A `dns.lookup`-compatible hook that resolves once, refuses if **any** returned
 * address is non-public (in public mode), and hands back the exact address the
 * socket will use.
 */
function guardedLookup(allowPrivate: boolean) {
  return (
    hostname: string,
    lookupOptions: unknown,
    callback: (err: NodeJS.ErrnoException | null, address: string, family: number) => void,
  ): void => {
    const base = typeof lookupOptions === "object" && lookupOptions !== null ? lookupOptions : {};
    dnsLookup(hostname, { ...(base as object), all: true }, (err, addresses: LookupAddress[]) => {
      if (err) return callback(err, "", 0);
      const list = Array.isArray(addresses) ? addresses : [addresses];
      if (list.length === 0) return callback(new BlockedDestinationError("no address"), "", 0);

      if (!allowPrivate) {
        for (const entry of list) {
          if (!isPublicAddress(entry.address, entry.family)) {
            // Refuse the whole hostname, not just the offending record — a
            // mixed answer is exactly how rebinding is staged.
            return callback(new BlockedDestinationError("non-public address"), "", 0);
          }
        }
      }
      const first = list[0]!;
      callback(null, first.address, first.family);
    });
  };
}

function toHeaderRecord(headers: RequestInit["headers"]): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) return Object.fromEntries(headers.entries());
  if (Array.isArray(headers)) return Object.fromEntries(headers);
  return { ...(headers as Record<string, string>) };
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === "string") out[k] = v;
    else if (Array.isArray(v)) out[k] = v.join(", ");
  }
  return out;
}

function abortError(): Error {
  const err = new Error("The operation was aborted");
  err.name = "AbortError";
  return err;
}
