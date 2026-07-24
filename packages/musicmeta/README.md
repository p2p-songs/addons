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

## Search index (optional accelerator)

MusicBrainz search is a cataloguer's Lucene index, not tuned for how people type:
no typo tolerance, and a bare artist match outranks a far more specific track
match — so `"justin bieber baby"` surfaces the *artist*, not the song. Set
`MEILI_URL` to put a **Meilisearch** index in front of catalog search:

- **read-through** — the index answers first, ranked and typo-tolerant;
- **write-back** — a MusicBrainz miss hydrates the index, so common queries get
  faster over time.

Two things this layer is, by design:

- **Identity only.** It stores exactly a `metaPreview` — entity-typed id, name,
  poster. **No hashes, no stream sources.** That is what makes it legally inert
  and safe to host and share (a *stream*-side hash cache is not — that lives
  per-user inside `stream-debrid`).
- **An accelerator, never a dependency.** With `MEILI_URL` unset, or if
  Meilisearch is down or slow, catalog search falls through to MusicBrainz
  exactly as before. A search never fails, or waits, because caching it did.

```sh
# Optional: ranked, typo-tolerant, self-warming search.
MEILI_URL=http://127.0.0.1:7700 MEILI_API_KEY=… PORT=7002 node dist/serve.js
```

`MEILI_INDEX` overrides the index name (default `catalog`). Meilisearch is
chosen over Typesense (MIT vs GPL-3.0 — this addon is meant to be self-hosted)
and Postgres FTS (no typo tolerance).

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
