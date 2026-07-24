# Railway deployment — musicmeta + Meilisearch

Three services in one Railway project: the stateless `musicmeta` addon (public),
a stateful Meilisearch (private, with a volume), and a scheduled `catalog-importer`
(private, cron) that pulls the nightly golden dataset from R2 into Meilisearch.
Cloudflare sits in front of `musicmeta` — see
[`../cloudflare/README.md`](../cloudflare/README.md).

```
  R2 (golden NDJSON, published nightly off-box by the catalog-nightly Action)
        │  fetch + verify
        ▼
  catalog-importer service (cron, private) ──▶ meilisearch service (volume, never public)
                                                    ▲  private networking
Cloudflare (free) ──▶ musicmeta service (public) ───┘  serves search from Meili only
```

MusicBrainz is **not** in this picture at request time — the catalogue is built
offline and shipped in via R2 (see `.github/docs/CATALOG_PIPELINE.md`). Meili is
the curated store musicmeta serves from, so the importer is what keeps it current.

## The one prerequisite: getting the SDK into the image

`musicmeta` depends on `@p2p-songs/addon-sdk` through an unpublished `link:` path
to a **sibling checkout**. Railway builds from a single connected repo, so its
native Dockerfile builder can't see that sibling. Two ways around it:

### A. Deploy the prebuilt image (works today — recommended)

Build locally, where both repos exist side by side, then push and point Railway
at the image. No SDK publish needed.

```sh
# from the p2p-songs parent dir (contains addon-sdk/ and addons/)
docker build -f addons/deploy/musicmeta.Dockerfile -t ghcr.io/<you>/musicmeta:latest .
docker push ghcr.io/<you>/musicmeta:latest
```

In Railway: **New Service → Deploy from Docker Image →** `ghcr.io/<you>/musicmeta:latest`.

### B. Native Dockerfile build (once the SDK is published)

When `@p2p-songs/addon-sdk` (+ `protocol`, `musicbrainz`) ship to a registry and
musicmeta's dependency flips from `link:` to a version (already on the roadmap —
see addon-sdk `CLAUDE.md`), Railway can build from the repo directly with a
trivial Dockerfile. Until then, use A.

## Service 1 — musicmeta (public)

- **Source:** the image from A (or native build per B).
- **Variables:**
  - `HOST=0.0.0.0` — bind the container interface (the addon defaults to
    loopback, which Railway can't route to).
  - `PORT` — injected by Railway; the addon honours it.
  - `MEILI_URL=http://meilisearch.railway.internal:7700` — the private-network
    hostname of service 2 (Railway gives each service a `*.railway.internal`
    address; use it so Meilisearch never needs a public domain).
  - `MEILI_API_KEY` — the Meili master key (or a scoped search+write key).
  - `MUSICMETA_USER_AGENT` — your own MusicBrainz contact string.
- **Health check:** `/manifest.json` (see `railway.json`).
- **Networking:** generate a public domain **only for this service**.

## Service 2 — meilisearch (private, stateful)

- **Source image:** `getmeili/meilisearch:v1.12` (pin a real release).
- **Volume:** attach one mounted at `/meili_data`. This is the whole reason
  Meilisearch can't be serverless — it needs a persistent disk.
- **Variables:** `MEILI_MASTER_KEY` (long random), `MEILI_ENV=production`,
  `MEILI_NO_ANALYTICS=true`, `MEILI_SCHEDULE_SNAPSHOT=86400`, and
  **`MEILI_MAX_INDEXING_MEMORY=256Mb`** — required: Meilisearch sizes its worker
  pool to the host CPU count, so an unbounded indexing spike OOM-kills it into a
  restart loop (seen live on a small Railway service). Give it ≥1 GB RAM.
- **Networking:** **do not** give it a public domain. It's reachable only over
  `*.railway.internal` from the other two services.

## Service 3 — catalog-importer (private, cron)

The runtime half of the pipeline: fetch the latest golden NDJSON from R2, verify
its checksum, and zero-downtime-reindex it into Meilisearch. It runs on a schedule
inside the project so it can reach `meilisearch.railway.internal` (Meili is never
public, so this can't run from the GitHub Action).

- **Source:** the image built from
  [`../catalog-importer.Dockerfile`](../catalog-importer.Dockerfile). Unlike
  musicmeta it has **no SDK `link:` dependency**, so it builds from the `addons`
  repo alone — Railway's native builder can do it, or push a prebuilt image:
  ```sh
  # from the addons repo root
  docker build -f deploy/catalog-importer.Dockerfile -t ghcr.io/<you>/catalog-importer:latest .
  docker push ghcr.io/<you>/catalog-importer:latest
  ```
- **Cron schedule:** set the service's cron to run **after** the nightly build
  (the Action runs 04:00 UTC), e.g. `30 4 * * *`. Railway runs the container to
  completion and it exits — the `import` command is one-shot.
- **Variables:**
  - `MEILI_URL=http://meilisearch.railway.internal:7700`, `MEILI_API_KEY`,
    `MEILI_INDEX=catalog`.
  - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
    `R2_BUCKET=songs-catalog` — R2 **read** credentials for `fetch`.
- **Networking:** no public domain.

> A leaner alternative avoids a third service entirely: have `musicmeta` itself
> notice `latest.json`'s sha256 changed and self-import. We keep it separate so
> the S3 client stays out of the runtime addon and imports are observable as their
> own job — but the option is open if you'd rather run two services.

## Backups

The **golden NDJSON in R2 is the system of record** — the Meili index is derived
and fully rebuildable from it (`catalog-builder import` against any fresh Meili).
So Railway's lack of managed backups doesn't matter: if Meili/Railway die, stand
Meili up anywhere and re-run the importer. Meili's own scheduled snapshots (→ R2
via [`../meilisearch/backup.sh`](../meilisearch/backup.sh)) are just a fast-restore
convenience on top of that. See [`../meilisearch/README.md`](../meilisearch/README.md).

## Rough cost

Meilisearch at 1–2 GB RAM ≈ $10–20/mo ($10/GB), musicmeta ~within the $5 Hobby
credit → **~$15–25/mo all-in**, Cloudflare $0.
