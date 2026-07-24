# @p2p-songs/catalog-builder

The **offline pipeline** for the curated music catalogue — builds the golden
dataset from MusicBrainz, publishes versioned snapshots to S3-compatible storage
(Cloudflare R2), and reindexes Meilisearch with zero downtime. It is an ops tool,
**not shipped in the runtime addon**, so it may take heavier dependencies (the AWS
S3 client) that `musicmeta` never does.

Design & rationale: [`p2p-songs/.github` — `docs/CATALOG_PIPELINE.md`](https://github.com/p2p-songs/.github/blob/main/docs/CATALOG_PIPELINE.md).

## The dataset

A newline-delimited JSON (NDJSON) document per catalogue entity — artist, album,
track — with a precomputed `searchtext = "<artist> <album> <title>"` ranking field
and a sanitized `docId` primary key. NDJSON is the portable lingua franca every
search engine ingests, so the data outlives any engine choice.

Snapshots are **immutable and dated** (`datasets/catalog-<YYYY-MM-DD_HHMM>.ndjson`);
a single `latest.json` manifest points at the current one and carries a **sha256**
(verified on fetch) and **per-type counts** (`{artist, album, track}`, which the
player surfaces as "X songs · Y albums · Z artists indexed"). We version with
dated keys, not the bucket's native object versioning, so the scheme is portable
to any S3 provider.

## Commands

```
node dist/cli.js publish <file.ndjson>   upload an immutable snapshot + repoint latest.json
node dist/cli.js stage   <file.ndjson> [dir]   write those objects to a local dir (any uploader)
node dist/cli.js import  [--]           R2 latest → verify → zero-downtime reindex into Meili
node dist/cli.js fetch   [out.ndjson]   download latest, verify sha256, write it out
node dist/cli.js versions               list snapshot keys, newest first
node dist/cli.js rollback <key>         repoint latest.json at an existing snapshot
```

`import` builds a `<index>__staging` index, applies the validated search settings,
streams the dataset in, then **atomically swaps** it with the live index — so the
live catalogue is never half-populated and removed songs actually disappear.

## Configuration (environment only — never the CLI or the repo)

R2 (S3-compatible):

| Env | |
|---|---|
| `R2_ACCOUNT_ID` | Cloudflare account id (endpoint is derived) — or set `R2_ENDPOINT` |
| `R2_ACCESS_KEY_ID` / `R2_SECRET_ACCESS_KEY` | R2 API token credentials |
| `R2_BUCKET` | default `songs-catalog` |

Meili (`import` only):

| Env | |
|---|---|
| `MEILI_URL` | e.g. `http://meilisearch.railway.internal:7700` |
| `MEILI_API_KEY` | if the instance is secured |
| `MEILI_INDEX` | default `catalog` |

## Where it runs

**build + publish** run off the serving box (a nightly GitHub Action). **import**
runs *inside* Railway, where it can reach the private Meili. R2 is the public
handoff between the two halves. See `docs/CATALOG_PIPELINE.md` → "Where it runs".

## Status

Storage + import proven end-to-end against real R2 + Meili. The current data
builder is a prototype (`../musicmeta/scripts/build-sample.mjs`, per-artist API
traversal, curated seed); the production `build` will process the MusicBrainz
canonical bulk dump + ListenBrainz popularity offline. 7 tests.

Build: `pnpm build` · Test: `pnpm test` · Typecheck: `pnpm typecheck`.
