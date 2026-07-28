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

- **`packages/catalog-builder`** (`@p2p-songs/catalog-builder`) — the **offline
  metadata pipeline**, not shipped in any runtime addon (so it may take heavier
  deps — the AWS S3 client). Builds the curated golden catalogue (NDJSON) from
  MusicBrainz, publishes versioned checksummed snapshots to R2 (the system of
  record), and reindexes Meilisearch with a zero-downtime swap. CLI: `publish |
  stage | import | fetch | versions | rollback`; creds from env only. See its
  `README.md` and `../.github/docs/CATALOG_PIPELINE.md`. This is what makes the
  `musicmeta` search plane a *curated store* rather than a live-MB accelerator.
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
  **Self-titled albums played the wrong song — a three-layer fix (2026-07-25,
  confirmed with `BITBOP_DEBUG` against a live Prowlarr).** `mbid:release:` album
  context for the Taylor Swift **self-titled** debut played evermore's "willow".
  Root cause, in order of importance:
  1. **The query was degenerate (`buildQueryString`, `torznab.ts`).** A self-titled
     album makes the query `"Taylor Swift Taylor Swift"`, which matches *every*
     release by her; the indexer returns the top-seeded albums and the low-seeded
     2006 debut **never appears in the results at all** — so no amount of ranking
     could pick it. Fix: when the album title equals the artist name, **append the
     album `year`** (`"Taylor Swift Taylor Swift 2006"`) to narrow the indexer to
     the actual release. Self-titled only, so normal albums (whose torrents may
     omit the year) aren't over-filtered.
  2. **Ranking ignored album relevance (`candidateScore`).** A fuzzy `q=` still
     returns deluxe editions / **discography packs** / other albums; format+seeders
     alone picked the most-seeded and `pickFile` returned *its* track at the
     position. Fix: `albumRelevance(title, track)` = fraction of album tokens
     present **+ a bonus when the `year` appears** − a **collection/discography
     penalty** (keyword-based; a year-range heuristic misfires on a normal
     `1989 (2014)`), weighted `×1000` so it dominates format/seeders.
  3. **Cached-first probe order & format-only final `rankStreams` override
     relevance.** A wrong-album torrent already on the account (or a better format)
     could still win. Fix: `keepRelevantCandidates` **gates out** candidates a
     full point below the best (a different album by the year signal) *before*
     the cached-first sort, so those two steps only ever choose within the right
     album. Gate is a no-op when nothing decisive separates candidates (keeps all)
     and always keeps the best.
  `year` rides on `TrackContext` from `getRelease`'s `groupFirstReleaseDate`. A
  bare recording (no album context) scores 0 / isn't gated → unchanged
  seeders/format ranking. `BITBOP_DEBUG=1` logs the resolved album/year and each
  candidate's score + keep/drop — how this was diagnosed.
  **Within the right album, `candidateScore` is speed-first (2026-07-26).**
  Album relevance still dominates (`×1000`, the whole self-titled fix), but the
  tiebreak *inside* the winning album is now **seeders first, format last** —
  reversed from the original format-first order. The score is
  `albumRelevance×1000 + log10(seeders+1)×100 + formatRank`: seeders drive it
  (an uncached torrent with more peers downloads faster, so the user hears the
  song sooner — the `downloadUncached` path picks the first relevant candidate,
  which is now the best-seeded), `log10` models real download speed (1→10 peers
  matters far more than 100→1000) and keeps even 100k seeders ≈500, safely under
  the `×1000` album band so speed can never promote a wrong-album torrent, and
  format only breaks ties between comparably-seeded rips. Note this is the
  *candidate/torrent* choice; `pickFile`'s FLAC-over-MP3 preference for the
  *file* inside an already-chosen torrent is unchanged (quality once the bytes
  are already local).
  **Uncached download tolerates a dead top-seed (2026-07-28).** The indexer's
  seeder count is only a hint — the best-ranked torrent can be dead on the debrid
  side (0% forever, then an error status). The old `maybeStartDownload` committed
  to the single best candidate and, on a `dead` verdict, returned a no-match — so a
  dead top-seed produced *both* observed bugs at once: a re-poll re-added the
  deleted torrent (stuck "Downloading… 0%") while the `dead` poll surfaced as
  "addon couldn't find a source", with no fallback to the album's ten other
  sources. Now it's **two phases**: (1) **resume** — a read-only `listActive` scan
  (new optional `DebridProvider` method; RD reads `GET /torrents` for
  `STATUS_IN_PROGRESS` hashes with live `progress`) reports an already-running
  download's progress with **no writes**, and deliberately does *not* touch a
  higher-ranked candidate a prior poll found dead; (2) **start-with-fallback** —
  when nothing runs yet, start the best and, on `dead`, fall through to the next up
  to `MAX_DOWNLOAD_STARTS` (3), a no-match only when *every* attempt is dead. This
  start cost is paid ~once; later polls take the write-free resume path. Also:
  while a download is in progress the resolver **suppresses the uncached
  `addMagnet` probes** (the recurring per-poll burst that tripped RD's 429 and
  could stall the very download) — cheap on-account reads still run, only the adds
  are gated. `listActive`/`listCached` are optimizations, never gates: a provider
  may omit them and a blip just costs the optimization.
  **Hosting (2026-07-28).** `serve.ts` reads `HOST` (defaults `127.0.0.1`;
  container hosts set `0.0.0.0` — it previously bound only loopback, unroutable on
  Railway). Deploy assets: `deploy/bitbop.Dockerfile` (parent-context build, same
  SDK `link:` prerequisite as musicmeta → ship a prebuilt image),
  `deploy/railway/bitbop.railway.json`, and the shared-setup runbook
  `deploy/railway/shared-setup.md` (Prowlarr + Bitbop + PHONO in the Shape-A model).
  Deployed **public-safe** (never `BITBOP_ALLOW_PRIVATE_INDEXERS` on a public
  instance) → Prowlarr must be a public, API-key-gated domain. Provisioning
  scripts: `deploy/prowlarr/provision-indexers.mjs` (re-adds the six public
  indexers to a fresh Prowlarr) and `deploy/bitbop/gen-install-url.mjs` (builds the
  shared install URL, pulling the indexer list from Prowlarr; RD key via env, never
  hardcoded). Both Docker images build + run verified locally.
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
  make that write safe: anything the addon adds **to check** is **deleted unless
  cached** (never a torrent the user already had) — with **one deliberate
  exception**: `startDownload` (the `downloadUncached` feature, 2026-07-26)
  *keeps* an in-progress download because the user pressed play, reporting a
  `resolving`/progress marker the player waits on; it still finds an existing
  download by hash before adding (RD's `addMagnet` doesn't dedupe) and still
  deletes a dead/no-audio torrent. selection is **audio-only,
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

  **Search — curated Meilisearch catalogue (2026-07-24; supersedes the
  read-through/write-back accelerator).** The plane was **inverted**: Meilisearch
  is no longer an accelerator hydrated by write-back from free-text MB (that
  filled it with parodies and coupled every query to MB's rate budget). It is now
  the **curated catalogue `musicmeta` serves search from**, built *offline* and
  imported; **MusicBrainz never runs in the search path** (it still enriches per-item
  **meta** — album track listings — a bounded cached lookup, not search). An offline
  pipeline (`@p2p-songs/catalog-builder`) **joins** two CC0 sources — popularity from
  **ListenBrainz sitewide top artists** (the scope) and content from the **MB
  canonical bulk dump** filtered to those artists — publishes a versioned golden
  **NDJSON dataset to R2** (system of record), and a runtime **import** does a
  zero-downtime swap into Meili. NB: the canonical dump's own `score` is *not*
  popularity (it's a row ordinal — an early build using it returned junk); the
  artist listen-count join is the fix. Player gets **one unified search** over
  artists/albums/songs ranked by stored `searchtext = "<artist> <album> <title>"` +
  artist-listen-count tiebreaker. **Invariants:** still **identity only**
  (`metaPreview`: id/name/poster, no hashes/sources → legally inert + shareable +
  default-installable, neutrality §11 governs the *stream* plane); Meili is a
  **required curated store, NOT "accelerator never a dependency"** — no live-MB
  fallback for search, resilience comes from the rebuildable R2 dataset. Full design:
  `../.github/docs/CATALOG_PIPELINE.md`. `musicmeta` now **reads the index only**
  (`MeiliSearchIndex`: search + `stats`, no write-back), and exposes **`/stats`**
  (per-type counts via Meili's `type` facet, wired through the SDK's `serveHTTP`
  `extraRoutes`) for the player's catalogue-size indicator.

  **A track search hit carries album context — `releaseId` (2026-07-25).** Without
  it a *search*-play sent a bare recording, and a stream addon (Bitbop) resolving a
  bare recording searches indexers by artist+title alone: a much-pressed old song
  (dozens of comps/promos/live/discography packs) can't be picked, while a new
  single-release song can — the "plays from the album screen, not from search" gap,
  and the "SWAG 2 plays but 2010 albums don't" report. `catalog-builder` stores
  `releaseId` (`mbid:release:<uuid>`, the canonical release the dump pairs with the
  recording) on every track doc; `meili.ts` also recovers it from the poster URL
  for pre-field docs, so it works against the current index without a rebuild. With
  it, `metadata.ts` resolves `getRelease` → `matchTrack` by recording id → disc+
  position → deterministic file pick, identical to an album-screen play. `releaseId`
  is a new optional `metaPreview` field, track previews only.

  **Hosting (2026-07-23):** ready-to-run assets in `deploy/` — `docker-compose.yml`
  (musicmeta + a private Meilisearch on one box), a Railway two-service setup,
  off-box Meili backups, and the Cloudflare edge (cache rule on catalog responses
  + rate limit + Bot Fight Mode). `serve.ts` now reads `HOST` (defaults to
  `127.0.0.1`; containers set `0.0.0.0`) so the SDK's loopback default doesn't make
  a pod unroutable. One build caveat baked into the Dockerfile: musicmeta's
  `link:` dep on the sibling SDK means the build context is the **p2p-songs
  parent**, so single-repo hosts (Railway's native builder) deploy the prebuilt
  image until the SDK is published. See `deploy/README.md`.

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

  27 musicbrainz tests / 24 musicmeta tests.

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
