# CLAUDE.md — addons

## Scope
The first-party reference addons, in build order (Plan §10, Phase 3):

1. `musicmeta` — MBID → metadata + cover art (MusicBrainz + Cover Art Archive)
2. `catalog-charts` — MusicBrainz browse + ListenBrainz trending/similar
3. `stream-legal` — Jamendo/Internet Archive/FMA, direct URLs, zero config
4. `stream-ytmusic` — `ytId`-style, official YouTube embed
5. `lyrics-lrclib` — lyrics via lrclib.net
6. **`bitbop`** (the `stream-debrid` reference addon; `bitbop` is the display/
   package name, `stream-debrid` the role) — **the highest-scrutiny addon in
   this repo. Implemented 2026-07-21 (see Status).** One self-contained addon
   (discovery + aggregation + **file selection** + debrid resolution), modeled on
   Torrentio, not AIOStreams. Read Plan §2/§2a and §3 in full before touching
   this addon's code. Note the music-specific step:
   requests are keyed by `mbid:recording:<uuid>` (the song) but music torrents
   are **whole albums** — so it must pick the *right track file* inside a
   multi-file album torrent (by disc+track position when the request's
   album-context `mbid:track:`/`mbid:release:` is present, else fuzzy
   title+duration). "Largest file" (Torrentio's movie heuristic) does NOT work
   for music. See Plan §2a.

Full architecture: [`p2p-songs/.github` — `docs/IMPLEMENTATION_PLAN.md`](https://github.com/p2p-songs/.github/blob/main/docs/IMPLEMENTATION_PLAN.md).

## Before implementation
Read `../.github/docs/audits/README.md` and its first (latest) report before
starting work. The registry owns current sign-off and supersession; do not rely
only on issue notifications.

## Invariants this repo must hold (see `.github`'s `docs/REVIEW_CHECKLIST.md` §2-§6 — read that file in full before implementing or reviewing `stream-debrid`)
Summary (checklist has the complete, cross-referenced version):
- `bitbop`/`stream-debrid`: one addon, no plugin interface for aggregating other
  addons; never persists resolved audio bytes on its own infra; every
  debrid API call uses that request's own `/configure` credentials, never
  a shared/pooled account; ships no built-in tracker list (indexers come from
  the user's config).
- `stream-ytmusic`: official embed (`ytId`-style), not raw `yt-dlp`
  extraction, by default.
- `stream-legal`: fixed set of CC-licensed/open sources only, never an
  open proxy for arbitrary URLs.
- All addons: conform to the protocol/ID scheme from `addon-sdk`'s
  `defineStreamHandler` etc. — don't invent ad hoc response shapes.

## Workspace layout
This repo is a **pnpm workspace** (`packages/*`). Each addon is a package.
Cross-repo dependency on the SDK: pre-publish, packages consume
`@p2p-songs/addon-sdk` via a **`link:` dependency to the sibling checkout**
(`link:../../../addon-sdk/packages/sdk`) — this assumes the documented sibling
layout under `p2p-songs/` and that the SDK is built (`dist/`). Swap to a
versioned dependency once the SDK is published at v1. Tooling: TypeScript, zod
(via the SDK), vitest.

- **`packages/musicbrainz`** (`@p2p-songs/musicbrainz`) — a **shared,
  rate-limited MusicBrainz client** consumed by `musicmeta` and `stream-legal`
  (in-workspace `workspace:*` dep). MusicBrainz requires **≤1 req/sec per IP**,
  so every MB call goes through its `RateLimiter` (+ `503 Retry-After` backoff).
  Co-host addons in one process and share a limiter instance to hold the budget
  across them; separate processes each hold their own (external gateway / MB
  mirror for real multi-process scale). Audit A-006. Don't add a second MB client.

## Status
**Phase 3 exit criteria MET (2026-07-22)** — the full chain verified live
against a real debrid account and a self-hosted Prowlarr, the one thing CI can
never cover. `pickFile` chose correctly **26/26** on real album torrents. The
finding to remember: **Real-Debrid's file ids are not track order** (file id 1
was track 13), so any id-order or largest-file shortcut serves the wrong song
confidently — Plan §2a, now empirically confirmed rather than argued.

**`stream-legal` + `musicmeta` implemented (2026-07-19, Plan Phase 3);
`bitbop` implemented (2026-07-21, Plan Phase 3 #6).** The addon side of the
discovery→stream loop is complete and verified end-to-end (musicmeta album meta
→ `recordingId` → stream-legal → playable https url).

- **`bitbop`** (#6, the `stream-debrid` reference addon) — the highest-scrutiny
  addon here. `mbid:recording:` (+ optional album context) → MusicBrainz →
  fan-out to the **user's own** Torznab indexers → rank candidates → per torrent:
  debrid **cache check** → **`pickFile`** → **unrestrict** → resolved https
  stream. 160 tests, none needing network or a debrid account.
  **Invariants (don't regress):** the debrid key is a *required* config field
  read only from that request's `/configure` (no env var, no default, no pooled
  account) and `configurationRequired: true` makes the router **fail closed**;
  **no built-in tracker list** — indexers come from config; only candidate
  *metadata* is held, never audio bytes; a non-https unrestricted URL is
  rejected rather than handed to the player; `redactConfig` is the only thing
  diagnostics ever see; **total outage throws** (uncacheable 500) while a genuine
  no-match caches briefly — same A-006 semantics as `stream-legal`.
  **`pickFile` is the correctness-critical part (Plan §2a):** deterministic by
  disc+track position with album context, fuzzy title otherwise, and it will
  return *nothing* rather than a probably-wrong track. "Largest file" is never
  used. **It also takes `preferFormats`** — music torrents routinely ship the
  same album as FLAC *and* MP3 *and* WAV, so every encoding matches "track 3"
  equally well and the tie must be broken here. This can't be deferred to stream
  ranking, which only ever sees one already-chosen file per torrent. Falling back
  to "largest" is actively wrong: WAV is uncompressed, so it beat the FLAC every
  time (the bug this fixed). Title agreement still dominates — a better-matching
  MP3 beats a FLAC of the wrong song.
  **Discovery searches by the *track's* artist, not the release's.** A
  compilation is credited to "Various Artists", which is useless to search for —
  `MbTrack.artist` carries the per-track credit and `TrackContext.albumArtist`
  keeps the release credit for **grouping only** (a `bingeGroup` must be stable
  across an album, so it can't key on a per-track artist). Found live against
  Prowlarr, where the query went out as `"Various Artists The Baroque, Volume 1"`.
  **Searches are cached (`indexers/cache.ts`).** JIT resolution means a 12-track
  album is 12 `/stream` requests, and `buildQueryString` is album-scoped, so all
  12 sent byte-identical queries. `withSearchCache` collapses them into one, with
  **single-flight** (the player prefetches, so overlapping requests are normal),
  **shorter TTL for empty results**, and a **failure cooldown** — a rejection is
  *replayed* for ~60s rather than stored as an empty result, so the caller still
  sees the error (the resolver's outage-vs-no-match distinction depends on it)
  while the network cost stops. Measured live: a public indexer took **19.7s**,
  tripping the 10s client timeout, and because the rejection wasn't remembered
  every track of the album paid it again — an album was ~42s of dead waiting,
  now ~12s. The cache is **addon-scoped,
  not per-request** — building it per call defeats the entire purpose. In-memory
  and bounded on purpose: Comet uses a 30-day database, but Bitbop is stateless
  (Plan §2), and candidate metadata is the only thing §3 permits caching anyway.
  **A-011 (don't regress):** the indexer URL is caller-supplied and fetched
  server-side, so `src/net/` guards it — https-only in public mode, **every
  redirect hop re-validated**, and the **validated address is the connected
  address** (`node:http`'s `lookup` hook, so no DNS-rebinding window). **Literal
  IP hosts are checked separately** because Node skips DNS for a numeric host and
  a hook-only guard misses `https://169.254.169.254/…` — that bit v1. Public-safe
  is the **default**; a loopback/LAN indexer needs
  `BITBOP_ALLOW_PRIVATE_INDEXERS=1`. Also: a total debrid outage is an outage
  (retryable 500), not a cached no-match; and no config field may name a mode the
  addon can't serve — that's why AllDebrid and `cachedOnly` are out of the
  **schema**, not merely hidden in the UI.
  **Debrid account hygiene (don't regress):** Real-Debrid withdrew
  `/torrents/instantAvailability`, and the state machine that replaced it only
  reports `downloaded` *after* file selection — which is also what **starts a
  download**. So a cache check is unavoidably a write, and the rules exist to
  make that write safe: anything the addon adds to check is **deleted unless
  cached** (never a torrent the user already had); selection is **audio-only,
  never `files=all`**, so a miss can't cost a whole album; the torrent id is
  **threaded from `checkCache` into `resolveFile`** via `TorrentRef.handle` so
  one resolution never adds twice; a **non-mutating `GET /torrents` pre-pass**
  (`listCached`) answers what the account already holds, which for an album is
  every track after the first; and add-requiring probes are rationed separately
  (`MAX_UNCACHED_PROBES`) against RD's **250 req/min**. Also: RD reports errors
  in a **200 body** (`{error, error_code}`) — parse it, and map codes 8–15 to the
  same auth path as HTTP 401/403. We deliberately do **not** join the ecosystem's
  shared cache network (StremThru's Buddy/Peer): publishing which hashes are
  cached is a coordinated availability index, which Plan §3 rules out.
  **Measured against a live account (2026-07-21), not guessed:** `addMagnet`
  **does not dedupe** — re-adding a hash the account already holds returns a
  *new* torrent id, which is what makes the `listCached` pre-pass load-bearing
  rather than an optimization. A **cached** torrent settles in **~1330ms**
  (add 250 → `waiting_files_selection` 636 → select 895 → `downloaded` 1330) and
  RD round-trips run **~260ms p50**, so `CACHE_SETTLE_BUDGET_MS` is 3000ms of
  **wall clock** — bounding poll *attempts* instead made a nominal 2.5s budget
  take 4.8s, because it ignored the round-trip each attempt costs. `GET /torrents`
  returns `hash` as 40-char hex alongside `id`/`status`, as `listCached` assumes.
  Verified live: an uncached torrent is added, selected, refused, and **deleted**,
  leaving the account's torrent count unchanged.

- **`stream-legal`** (#3) — zero-config stream addon: `mbid:recording:<uuid>` →
  MusicBrainz metadata lookup → **fixed source allowlist** (Internet Archive
  always; Jamendo when `JAMENDO_CLIENT_ID` set) → score/rank → protocol streams.
  **A-006 invariants (don't regress):** emits a candidate only with a recognized
  **per-item CC/public-domain license** (fail closed — Archive hosting is not
  evidence; see `license.ts`); drops any non-https url; **requires artist
  agreement** before matching (`MIN_ARTIST_SCORE`, so a common title can't
  resolve to the wrong artist); a **total source outage** throws (uncacheable
  500) while a genuine no-match caches briefly (`max-age=300`). 25 tests.
- **`musicmeta`** (#1, the music Cinemeta) — zero-config catalog+meta addon:
  MusicBrainz search → `metaPreview[]` with entity-typed ids per content type;
  MusicBrainz lookup → `metaDetail`, where album meta carries `tracks[]` with
  **both** `recordingId` (streamable) and `trackId` (album context: disc +
  free-text position). Cover Art Archive posters. **Artist search leads
  somewhere:** a `byArtist` album catalog (`artistId` extra) returns the
  artist's discography as ordinary `mbid:release:` previews, so the player's
  album screen needs no special case. Three MusicBrainz facts make that list
  usable, and skipping any one produces a plausible-looking but useless result:
  a release *group* is the album while a release is one pressing (collapse to
  the earliest — the original, least likely to carry bonus-track padding);
  `primary-type: Album` still admits **live records, compilations and
  bootlegs**, so any `secondary-types` disqualifies (unfiltered, Radiohead
  returned 25 rows with zero studio albums); and browse pages at 100 in no
  useful order, so `type=album&status=official` filters server-side (1140
  releases → 274) to make a 3-page cap actually cover a discography. 17 tests.

All three consume the shared rate-limited `@p2p-songs/musicbrainz` client;
sources, indexers, and debrid providers are injected behind interfaces
(unit-tested without network) + fake-`fetch` adapter tests; all compose with and
inherit the SDK router boundary. **A-006 (1 critical + 5 medium across SDK +
these addons) reconciled 2026-07-20; not yet re-audited.**

Remaining scaffolding-only: `catalog-charts`, `stream-ytmusic`, `lyrics-lrclib`.

**Player-side gate satisfied alongside `bitbop`:** Checklist §7 required a v1
browser threat model *before* a credential-bearing addon lands. The player now
ships a strict production CSP (`script-src 'self'`, no inline/eval, Trusted
Types, Vite's modulepreload polyfill disabled so no inline script exists), a
redacted `ErrorBoundary`, and `redactSecrets` for free text. See the player repo.

## Being audited?
If you're the adversarial reviewer, not the implementer: start at
[`p2p-songs/.github` — `docs/ADVERSARIAL_REVIEW_CONTRACT.md`](https://github.com/p2p-songs/.github/blob/main/docs/ADVERSARIAL_REVIEW_CONTRACT.md),
not this file.
