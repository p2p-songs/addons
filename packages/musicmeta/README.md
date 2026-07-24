# @p2p-songs/musicmeta

The p2p-songs **metadata** addon — the music equivalent of Cinemeta. Provides
`catalog` (search) and `meta` (full detail) for artists, albums, and tracks,
backed by **MusicBrainz** with **Cover Art Archive** posters. Zero configuration.

Built on [`@p2p-songs/addon-sdk`](../../../addon-sdk/packages/sdk).

## What it produces

This is the discovery half of the system — it's what turns a search or an id
into the **entity-typed ids** everything else keys on:

- **catalog** (`/catalog/<type>/search/search=<q>.json`) → `metaPreview[]`, each
  with the right id for its type: `artist`→`mbid:artist:`, `album`→`mbid:release:`,
  `track`→`mbid:recording:`. The SDK's discriminated-union schema rejects any
  type↔id mismatch, so identity is honest by construction.
- **meta** (`/meta/<type>/<id>.json`) → full detail. An **album** meta carries a
  `tracks[]` listing where each entry has **both** the `recordingId` (the
  streamable identity `stream-legal`/`stream-debrid` resolve against) **and** the
  `trackId` (album context: disc + free-text position). The recording/track split
  and multi-disc / bonus-disc / vinyl cases are preserved end-to-end.

Meta is keyed off the id's *entity*, not the route type, so identity is
authoritative. A bare `mbid:track:` is intentionally not addressable on its own.

## The loop

`musicmeta` album meta yields a `recordingId`; `stream-legal` (or `stream-debrid`)
resolves that same `recordingId` to a playable stream. The shared
`mbid:recording:` identity is the entire contract between the two.

## Search — a curated Meilisearch catalogue

> **Design evolving (2026-07-24).** Search is moving from a Meilisearch
> *accelerator in front of live MusicBrainz* to Meilisearch as the **curated
> catalogue this addon serves from**, built offline. MusicBrainz search is a
> cataloguer's index that returns parodies/covers for how people actually type
> (`"justin bieber baby"` surfaced the *artist* or a parody, not the song), and
> hydrating an index by writing those results back inherited the junk. The fix is
> curation, not ranking tricks.

**The plane, now:** an offline pipeline
([`@p2p-songs/catalog-builder`](../catalog-builder)) traverses **official
release-groups only** — so parodies/live/bootleg can't enter — scoped by
ListenBrainz popularity and sourced from the MusicBrainz canonical bulk dump (both
CC0), publishes a versioned golden **NDJSON dataset to R2**, and a runtime import
does a zero-downtime swap into Meilisearch. `musicmeta` then serves **one unified
search** over artists/albums/songs, ranked by a stored
`searchtext = "<artist> <album> <title>"` (which makes "baby", "baby justin
bieber", and "my world baby" all resolve to the song). Full design:
[`p2p-songs/.github` — `docs/CATALOG_PIPELINE.md`](https://github.com/p2p-songs/.github/blob/main/docs/CATALOG_PIPELINE.md).

Invariants: **identity only** (`metaPreview` — id/name/poster, no hashes/sources →
legally inert and shareable, unlike a *stream*-side hash cache which lives
per-user inside `stream-debrid`); and Meilisearch is now a **required curated
store**, not an optional accelerator — its resilience is the rebuildable,
provider-portable R2 dataset, not a live-MusicBrainz fallback. Chosen over
Typesense (MIT vs GPL-3.0) and Postgres FTS (no typo tolerance).

```sh
MEILI_URL=http://127.0.0.1:7700 MEILI_API_KEY=… MEILI_INDEX=catalog PORT=7002 node dist/serve.js
```

(The transitional `search-index.ts` read-through/write-back adapter is being
retired as serving moves to Meili-only.)

## Run

```sh
pnpm build
PORT=7002 node dist/serve.js
# install URL: http://127.0.0.1:7002/manifest.json
```

MusicBrainz requires a descriptive `User-Agent`; set `MUSICMETA_USER_AGENT` to
your own contact string before running against the live service.

Binding defaults to `127.0.0.1` (safe for local). In a container, set
`HOST=0.0.0.0` so the platform can route to it; `PORT` is honoured either way.

## Deploy (hosted)

`musicmeta` is meant to be hosted **once, centrally** — a shared metadata cache
for every player by construction (`.github/docs/DEPLOYMENT.md` → "The metadata
plane"). Ready-to-use assets live in [`../../deploy`](../../deploy): a
`docker-compose.yml` (musicmeta + a private Meilisearch on one box), a Railway
two-service setup, off-box Meilisearch backups, and the Cloudflare edge
(cache rule + rate limit + DDoS). Start at [`../../deploy/README.md`](../../deploy/README.md).

## Library use

`createMusicMetaAddon({ mb })` returns an SDK `AddonInterface`; the MusicBrainz
client is injected (behind `MusicBrainzClient`), so catalog/meta are unit-tested
without network. See `src/index.ts`.

Build: `pnpm build` · Test: `pnpm test` · Typecheck: `pnpm typecheck`.
