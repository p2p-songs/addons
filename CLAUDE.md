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

## Status
**`stream-legal` implemented (2026-07-19, Plan Phase 3 #1)** — the first
reference addon and first end-to-end slice. A zero-config stream addon:
`mbid:recording:<uuid>` → MusicBrainz metadata lookup → search a **fixed source
allowlist** (Internet Archive always; Jamendo when `JAMENDO_CLIENT_ID` is set) →
score/rank candidates (drops weak matches + any non-https url) → protocol stream
objects. Discovery/metadata/sources are injected behind interfaces so the
resolver is unit-tested without network; a fake-`fetch` test exercises the real
Internet Archive two-step (advancedsearch → metadata → download URL). 16 tests
(match, resolve, IA adapter, handler-via-SDK-router); typecheck + build green.
**Not yet audited.** Next reference addons: `musicmeta` / `catalog-charts`
(so a recording id can actually be discovered), then `stream-debrid` (last,
highest scrutiny).

Remaining scaffolding-only: `musicmeta`, `catalog-charts`, `stream-ytmusic`,
`lyrics-lrclib`, `stream-debrid`.

## Being audited?
If you're the adversarial reviewer, not the implementer: start at
[`p2p-songs/.github` — `docs/ADVERSARIAL_REVIEW_CONTRACT.md`](https://github.com/p2p-songs/.github/blob/main/docs/ADVERSARIAL_REVIEW_CONTRACT.md),
not this file.
