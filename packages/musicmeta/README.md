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

**Search is served entirely from a curated Meilisearch catalogue** built offline;
MusicBrainz is not in the search path. (It used to be an *accelerator in front of
live MusicBrainz*, read-through / write-back — but MB search returns parodies/covers
for how people actually type, e.g. `"justin bieber baby"` surfaced the artist or a
parody, and writing those back inherited the junk. The fix was curation, not ranking
tricks.)

**The plane, now:** an offline pipeline
([`@p2p-songs/catalog-builder`](../catalog-builder)) scopes to the most-listened
artists (ListenBrainz sitewide stats) and takes their catalogues from the MusicBrainz
canonical bulk dump (both CC0), publishes a versioned golden **NDJSON dataset to R2**,
and a runtime import does a zero-downtime swap into Meilisearch. `musicmeta` then
**only reads** that index — one unified search over artists/albums/songs, ranked by a
stored `searchtext = "<artist> <album> <title>"` (which makes "baby", "baby justin
bieber", and "my world baby" all resolve to the song) with the artist's listen count
as a popularity tiebreaker. Full design:
[`p2p-songs/.github` — `docs/CATALOG_PIPELINE.md`](https://github.com/p2p-songs/.github/blob/main/docs/CATALOG_PIPELINE.md).

**Meta** detail (`/meta/...` — album track listings with disc/position/duration) still
enriches per-item from MusicBrainz: it is a bounded, cached, per-item lookup, not the
scaling-critical search path, and it is the source of track ordering the curated search
docs deliberately don't carry.

**`/stats`** returns the live catalogue counts (`{artist, album, track, total}`, from
Meili's `type` facet) for the player's "X songs · Y albums · Z artists indexed"
indicator — `503` when no index is configured.

Invariants: **identity only** (`metaPreview` — id/name/poster, no hashes/sources →
legally inert and shareable, unlike a *stream*-side hash cache which lives
per-user inside `stream-debrid`); and Meilisearch is a **required curated
store**, not an optional accelerator — its resilience is the rebuildable,
provider-portable R2 dataset, not a live-MusicBrainz fallback. Chosen over
Typesense (MIT vs GPL-3.0) and Postgres FTS (no typo tolerance).

```sh
# production: search from the curated index + enable /stats
MEILI_URL=http://127.0.0.1:7700 MEILI_API_KEY=… MEILI_INDEX=catalog PORT=7002 node dist/serve.js
# no MEILI_URL → search falls back to direct MusicBrainz (dev convenience only)
```

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
