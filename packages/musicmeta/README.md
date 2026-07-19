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

## Run

```sh
pnpm build
PORT=7002 node dist/serve.js
# install URL: http://127.0.0.1:7002/manifest.json
```

MusicBrainz requires a descriptive `User-Agent`; set `MUSICMETA_USER_AGENT` to
your own contact string before running against the live service.

## Library use

`createMusicMetaAddon({ mb })` returns an SDK `AddonInterface`; the MusicBrainz
client is injected (behind `MusicBrainzClient`), so catalog/meta are unit-tested
without network. See `src/index.ts`.

Build: `pnpm build` · Test: `pnpm test` · Typecheck: `pnpm typecheck`.
