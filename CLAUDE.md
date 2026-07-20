# CLAUDE.md — addons

## Scope
The first-party reference addons, in build order (Plan §10, Phase 3):

1. `musicmeta` — MBID → metadata + cover art (MusicBrainz + Cover Art Archive)
2. `catalog-charts` — MusicBrainz browse + ListenBrainz trending/similar
3. `stream-legal` — Jamendo/Internet Archive/FMA, direct URLs, zero config
4. `stream-ytmusic` — `ytId`-style, official YouTube embed
5. `lyrics-lrclib` — lyrics via lrclib.net
6. `stream-debrid` — **the highest-scrutiny addon in this repo.** One
   self-contained addon (discovery + aggregation + **file selection** + debrid
   resolution), modeled on Torrentio, not AIOStreams. Read Plan §2/§2a and §3
   in full before touching this addon's code. Note the music-specific step:
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
- `stream-debrid`: one addon, no plugin interface for aggregating other
  addons; never persists resolved audio bytes on its own infra; every
  debrid API call uses that request's own `/configure` credentials, never
  a shared/pooled account.
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
**`stream-legal` + `musicmeta` implemented (2026-07-19, Plan Phase 3).** The
addon side of the discovery→stream loop is complete and verified end-to-end
(musicmeta album meta → `recordingId` → stream-legal → playable https url).

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
  free-text position). Cover Art Archive posters. 14 tests.

Both consume the shared rate-limited `@p2p-songs/musicbrainz` client; sources
are injected behind interfaces (unit-tested without network) + fake-`fetch`
adapter tests; both compose with and inherit the SDK router boundary. **A-006
(1 critical + 5 medium across SDK + these addons) reconciled 2026-07-20; not yet
re-audited.**

Remaining scaffolding-only: `catalog-charts`, `stream-ytmusic`, `lyrics-lrclib`,
`stream-debrid` (last, highest scrutiny).

## Being audited?
If you're the adversarial reviewer, not the implementer: start at
[`p2p-songs/.github` — `docs/ADVERSARIAL_REVIEW_CONTRACT.md`](https://github.com/p2p-songs/.github/blob/main/docs/ADVERSARIAL_REVIEW_CONTRACT.md),
not this file.
