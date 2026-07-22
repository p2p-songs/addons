# Bitbop

**Turns torrent bits into bops.** Bitbop is the `stream-debrid` reference addon
(Implementation Plan §2) — one self-contained p2p-songs stream addon in the
[Torrentio](https://github.com/TheBeastLT/torrentio-scraper) shape: it discovers
releases on **your own** indexers, picks the right track file inside a
whole-album torrent, and resolves it through **your own** debrid account to a
direct, Range-servable link. The player only ever receives a resolved `https`
URL — never a magnet, never an `infoHash`.

> `bitbop` is the fun name; `stream-debrid` is the role. Same addon.

## What makes it "Bitbop" and not just a debrid proxy

- **One addon, no plugin layer.** Discovery, ranking, file selection, and debrid
  resolution all live here (Plan §2). It is not an AIOStreams-style meta-layer
  that aggregates other addons.
- **The music-specific step (Plan §2a).** A movie torrent is one file; a music
  torrent is a whole album. "Largest file" is meaningless, so Bitbop selects the
  *right track* — deterministically by **disc + track position** when the request
  carries album context (`mbid:track:` / `mbid:release:`), else by a fuzzy
  **title** match. See [`src/pick-file.ts`](./src/pick-file.ts).

## Legal posture (Plan §3 — non-negotiable)

- **Your credentials, never an operator's.** Every debrid call uses the API key
  from *that request's* `/configure` config. There is no environment variable,
  no default, no pooled account — the config type makes the key required and the
  addon reads it from nowhere else.
- **Your indexers, not a bundled tracker list.** Bitbop ships discovery *logic*;
  the Torznab endpoints come from your config. (Torrentio ships its own list; we
  deliberately don't — "built-in discovery" and "a hardcoded illicit source" are
  distinguishable only by who chose the source.)
- **…and because that URL is caller-supplied, its destination is policed.**
  See [Indexer address policy](#indexer-address-policy).
- **Never stores audio.** Bitbop holds only candidate *metadata* (title, hash,
  size). The bytes flow debrid CDN → player; they never pass through Bitbop.

## Configure

Bitbop needs configuration, so the SDK router **fails closed**: a resource
request without a valid config segment is a 400 — a handler never runs without
your credentials. Open `/configure`, enter your debrid provider + key and your
Torznab indexers, and it generates a personal install URL:

```
https://<your-bitbop-host>/<base64url-config>/manifest.json
```

**That URL contains your debrid key.** It's what lets Bitbop work without an
account of its own — and it means the URL is a password. Don't share it. Your
player stores it as a secret and shows it redacted. The `/configure` page is
served under a strict CSP with a per-render nonce and never echoes your key back
into the HTML.

## Run

```bash
pnpm build
PORT=7003 node dist/serve.js       # → http://127.0.0.1:7003/configure
```

There are no credential environment variables — that's by design. A deployer
runs the service (publicly, like Torrentio, is fine); each user brings their own
account.

## Indexer address policy

Bitbop fetches an indexer URL that *the caller* supplies. On a publicly reachable
instance that is SSRF unless the destination is policed, so it is (audit A-011):

- **https only**, and only **publicly-routable** destinations.
- **Every redirect hop is re-checked** — a permitted public URL that redirects to
  `http://127.0.0.1` doesn't get a free pass.
- **The address validated is the address connected to**, so DNS rebinding has no
  window. Literal IPs (including `::ffff:127.0.0.1`) are checked too — Node skips
  DNS for numeric hosts, which is exactly how such a guard usually leaks.

**Self-hosting?** Your Jackett/Prowlarr is probably on `http://localhost:9117`,
which the above refuses. Opt in explicitly:

```bash
BITBOP_ALLOW_PRIVATE_INDEXERS=1 PORT=7003 node dist/serve.js
```

Only ever set that on an instance **you alone can reach** — it is precisely the
policy that makes a public instance safe. The active mode is logged at startup
and shown on the `/configure` page, which pre-checks your URL against it.

## Supported providers

| Provider | Status |
|---|---|
| Real-Debrid | implemented (`src/debrid/realdebrid.ts`) |

Only providers with a working adapter appear in the config schema at all, so a
config can never name a mode Bitbop can't serve — AllDebrid was briefly
selectable without an adapter, which let you build a valid-looking install URL
that could never produce a stream (audit A-011). Adding a provider is a
`DebridProvider` implementation, a registry entry, and the id in the schema.

**Bitbop only returns already-cached torrents.** That isn't a setting — resolving
an uncached torrent means waiting on a debrid-side download, which a player can't
do mid-queue.

## Why checking the cache is not a read

Real-Debrid withdrew `/torrents/instantAvailability`. What replaced it is a state
machine that only reports `downloaded` **after** file selection — and selection is
also what starts a download. There is no read-only way left to ask "is this
cached?"; every serious client works around it (MediaFusion scans your account
list, Comet and StremThru consult a shared availability database).

Bitbop keeps the question local, and makes the unavoidable write safe:

- **A non-mutating pre-pass** (`GET /torrents`) answers every candidate your
  account already holds. Playing an album, that's the common case — track 1
  leaves the torrent there, so tracks 2…n add nothing at all.
- **Anything added to check is deleted unless it turns out cached.** A cache
  check never leaves a download running. A torrent *you* already had is never
  touched.
- **Only audio files are selected**, never `files=all` — so a miss can't cost you
  an entire album's download, and the link list stays free of cover art and logs.
- **Probes that require an add are rationed** separately from free ones. RD allows
  250 requests/minute and the player prefetches ahead of playback.

Bitbop deliberately does **not** join the shared cache networks. Publishing which
hashes are cached is a coordinated availability index, which is exactly the line
[Legal posture](#legal-posture-plan-3--non-negotiable) draws. The honest cost:
the first query for a torrent nobody has fetched yet is always a real round-trip.

The timings above aren't guesses — they were measured against a live Real-Debrid
account. A cached torrent settles in **~1330 ms** and API round-trips run
**~260 ms**, which is where the 3-second wall-clock budget comes from. Re-adding
a hash the account already holds returns a **new** torrent id, so Real-Debrid does
*not* deduplicate — that single fact is why the pre-pass exists.

## Verified end to end (2026-07-22)

The whole chain has been run against a real Real-Debrid account and a real
self-hosted Prowlarr — the Plan's Phase 3 exit criterion, which no CI can cover:

> player → musicmeta → Bitbop → MusicBrainz → Torznab → RD cache check →
> `pickFile` → unrestrict → https link → audio playing

**`pickFile` chose correctly 26/26**, across two independently-encoded rips of
the same album (13/13 each by disc+position, plus the fuzzy path). The reason
that matters is visible in one of those rips:

```
file id  1  →  13. cigarette smoke.flac     ← track 13
file id 13  →  01. drop dead.flac           ← track 1
```

**Real-Debrid's file ids are not track order.** An implementation that assumed
they were — or that reached for Torrentio's largest-file heuristic — would have
served the wrong song for every request, confidently. That is the entire reason
[`pick-file.ts`](./src/pick-file.ts) exists.

Two matches also survived only because of normalization: a request for
`u + me = -3` matched `05. u + me = 3.flac`, and `what’s wrong with me` carries a
curly apostrophe (U+2019) that NFKD folds. Naive string comparison misses both.

## Tests

`pnpm test` — 160 tests, no network or debrid account required (indexers, the
debrid provider, and metadata are all injected behind interfaces and driven with
fakes). The correctness-critical file-selection logic is the most heavily
covered, followed by the address policy (every deny range asserted individually,
plus a loopback listener that proves the guard never opens the connection).

The Real-Debrid fake models the **real** state machine — a magnet lands in
`waiting_files_selection`, only selection moves it on, and `links` is derived
from what was selected. That matters: the earlier fake let `checkCache` look
correct while, against the live API, it was adding torrents to the user's account
and starting album downloads. A fake that agrees with your assumptions tests
nothing.
