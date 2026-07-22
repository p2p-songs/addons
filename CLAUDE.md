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
  **Wrap it in `CachedMusicBrainz` in every `serve.ts`** (all three already do).
  Stream resolution is **per track and just-in-time** (Plan §2), so a 12-track
  album is 12 `/stream` requests that each look up *the same release* for its
  disc+position: measured at **12 requests, one distinct URL — 12s of the 1
  req/sec budget to play one album**, now 1. It caches entity lookups and the
  discography (machine-driven, repeat verbatim) and passes free-text searches
  through (user-typed, vary). Single-flight, because the player prefetches and
  those lookups genuinely overlap; the caller's `AbortSignal` is deliberately
  **not** forwarded into a shared load, so one caller's cancellation can't abort
  another's work. Bounded and in-memory — a request-coalescing buffer, not a
  datastore (Plan §2 keeps addons stateless).

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
  a hook-only guard misses `https://169.254.169.254/…` — that bit v1. **A-012:
  classify addresses on their bits, never their text.** `ip-policy.ts` parses
  IPv6 into eight words and judges the embedded v4 numerically, because one
  address has many spellings and an attacker picks the spelling: `::ffff:7f00:1`,
  `0:0:0:0:0:ffff:7f00:1` and `::ffff:127.0.0.1` are all loopback, and the last
  is the one form `new URL()` never yields — it rewrites the dotted quad to hex,
  so v2's prefix regex matched only the unreachable case. Public-safe
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
  album screen needs no special case.

  **The discography is a release-*group* `search`, not a release `browse`**
  (`artistDiscography`) — one request per artist, complete. Three live
  measurements forced that, and each was a bug first:
  - **Browsing releases cannot be bounded.** An album is one release group but
    dozens of pressings, so a release-browsed discography is mostly duplicates:
    Taylor Swift has **981** official album releases over 10 pages, returned in
    date order — so the *newest* albums are on the *last* page. A 3-page cap
    showed **6 of her 18 albums** and silently hid everything after 2017. Elvis
    Presley and Miles Davis need 16 pages; at ≤1 req/sec that is 16s of the
    shared budget, so "raise the cap" was not a fix.
  - **Browse cannot filter secondary types; search can.** `type=album` still
    admits live records, compilations and bootlegs — unfiltered, Radiohead
    returned 25 rows with **zero** studio albums, and Elvis has 1057 album
    groups. The Lucene term **`-secondarytype:*`** does it server-side: Swift,
    Elvis and Radiohead collapse to **18, 47 and 10 groups — one page each**.
  - **Release-group search results embed their `releases`**, so that one request
    also yields the release id the album's identity needs. (`inc=releases` is
    **400 on release-group browse** — the other half of why this is a search.)

  Ids stay `mbid:release:` so nothing downstream changes, but **posters now come
  from the release *group*** — art is uploaded per pressing, so a group-less
  poster URL is why some rows showed a broken thumbnail.

  **Album meta goes through `getAlbum`, not `getRelease`** — and that is a
  playability fix, not a cosmetic one. A release group mixes the original album
  with its later deluxe/anniversary/expanded editions, and the discography
  search **cannot tell them apart**: its embedded releases carry only `id`,
  `title` and `status`. So evermore resolved to a **17-track deluxe**
  (2021-01-07) instead of the **15-track original** (2020-12-11), and its two
  bonus tracks were then unplayable — they are on no ordinary rip, so `pickFile`
  correctly refused rather than serving the wrong song. 15 played, 2 didn't.
  `getAlbum` swaps a later edition for the album as first released, which is the
  **conservative direction**: a deluxe only ever *appends*, so positions 1..n
  still line up if the source turns out to be a deluxe rip and the user merely
  doesn't see bonus tracks; the reverse advertises tracks that usually cannot be
  found. It is **free in the common case** — `getRelease` already asks for
  `release-groups`, so a pressing whose date equals the group's
  `first-release-date` is returned untouched. Consequence to know:
  **`meta.id` may differ from the catalog row's id.** The catalog row is an
  entry point into the album; meta names the edition actually chosen, and that
  is the id the player then hands Bitbop as album context.
  **Which pressing represents the group is correctness-critical, not cosmetic.**
  We shipped the Taiwanese SOUR — tracks titled `brutal 残酷`, artist credited
  `奧莉維亞` — and that name reaches Bitbop's indexer query, so every search was
  a guaranteed miss against torrents named "Olivia Rodrigo". There are **two
  pickers**, because the two paths see different data:
  - `representativeRelease` (discography). Search embeds only `id`/`title`/
    `status` per release — no date, no credit — so the choice is **Official**
    (never a bootleg or promo) plus a title equal to the group's, which is both
    the canonical-name test and what excludes bonus-track deluxe editions.
    Measured canonical on 17/17 albums across three artists. Residual risk, if
    it ever surfaces: a pressing keeping the exact album title while
    re-crediting the artist in another script is invisible from here — fix it
    with a corrective lookup in `getRelease`, not more guessing at this level.
  - `betterRepresentative` (album search), which *does* have full release data.
    Two independent causes of the original bug, both fixed there:
    - **Dates carry precision** (`2021`, `2021-08`, `2021-05-21`), and
      string comparison makes the *vaguest* win: `"2021" < "2021-05-21"`. The
      year-only Taiwanese pressing thereby posed as the original. `dateKey`
      pads unknown month/day to the end of their period — a date known only to
      the year is not evidence of preceding a day inside it.
    - **Age was the only criterion.** Canonical naming now outranks it: a
      pressing that renames the album or re-credits the artist is unusable
      however original.

  The canonical test is self-contained and needs **no locale/country/script
  list**, because MusicBrainz stores the canonical name beside the localized one
  — `artist-credit[].artist.name` next to the as-credited `.name`, and the
  release *group*'s title next to the release's — so we just ask whether the
  pressing agrees with them. **Do not reach for `text-representation.script`**:
  it is wrong for exactly this case (the Japanese サワー pressing reports
  `Latn`). And nothing here privileges Latin script — an artist whose canonical
  names *are* non-Latin agrees with their own group title and artist name, so
  their pressings pass and the choice falls through to date.

  27 musicbrainz tests / 17 musicmeta tests.

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
