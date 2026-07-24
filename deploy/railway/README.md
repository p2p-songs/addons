# Railway deployment — musicmeta + Meilisearch

Two services in one Railway project: the stateless `musicmeta` addon (public)
and a stateful Meilisearch (private, with a volume). Cloudflare sits in front of
`musicmeta` — see [`../cloudflare/README.md`](../cloudflare/README.md).

```
Cloudflare (free) ──▶ musicmeta service (public)
                          │  private networking
                          ▼
                      meilisearch service (volume, never public)
                          │
                          └─▶ MusicBrainz (cold miss only)
```

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
  `MEILI_NO_ANALYTICS=true`, `MEILI_SCHEDULE_SNAPSHOT=86400`.
- **Networking:** **do not** give it a public domain. It's reachable only over
  `*.railway.internal` from musicmeta.

## Backups

Railway persists the volume, but ship snapshots off-box anyway (they're ~30 MB
for millions of docs). Either run [`../meilisearch/backup.sh`](../meilisearch/backup.sh)
from a small Railway cron service, or accept that the index is derived data and a
loss just means a slow re-warm from MusicBrainz. See
[`../meilisearch/README.md`](../meilisearch/README.md).

## Rough cost

Meilisearch at 1–2 GB RAM ≈ $10–20/mo ($10/GB), musicmeta ~within the $5 Hobby
credit → **~$15–25/mo all-in**, Cloudflare $0.
