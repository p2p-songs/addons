# Deploying the metadata plane (musicmeta + Meilisearch)

Everything needed to host `musicmeta` — the default-installed metadata addon —
with its optional Meilisearch search cache behind a Cloudflare edge. This is the
**metadata plane**; it is hosted once, centrally, and shared by every player by
construction (`.github/docs/DEPLOYMENT.md` → "The metadata plane"). It is *not*
the stream plane — musicmeta names no sources and holds no user credential.

```
players ──▶ Cloudflare (free)  ──▶  musicmeta  ──▶  Meilisearch (private)
             edge cache + DDoS        (public)  ──▶  MusicBrainz (cold miss only)
             + bot + rate limit
```

Three pieces, three shapes:

| Piece | Shape | Where |
|---|---|---|
| **musicmeta** | stateless HTTP addon | any container host; scale-to-zero friendly |
| **Meilisearch** | stateful, always-on, volume | VPS/GCE box, or a Railway service **with a volume** — never serverless |
| **Cloudflare** | edge | free plan, in front of musicmeta |

## Pick a path

- **One box (Tier 0, ~€5–12/mo)** — `docker compose up` on a VPS or a GCE VM,
  both services side by side, Cloudflare in front. See
  [`docker-compose.yml`](./docker-compose.yml). Cheapest, most control.
- **Managed (Railway, ~$15–25/mo)** — two Railway services (musicmeta public +
  Meilisearch with a volume), Cloudflare in front. See
  [`railway/README.md`](./railway/README.md). Least ops.
- **Managed Meilisearch** — Meilisearch Cloud for the stateful half + musicmeta
  on Cloud Run/Railway, if you'd rather not run Meilisearch at all.

## Quick start (Tier 0)

```sh
cd addons/deploy
export MEILI_MASTER_KEY="$(openssl rand -base64 36)"
docker compose up -d --build          # builds from the p2p-songs parent context
curl -s http://127.0.0.1:7002/manifest.json | head        # liveness
```

Then front `:7002` with Cloudflare ([`cloudflare/README.md`](./cloudflare/README.md))
and set up snapshots off-box ([`meilisearch/README.md`](./meilisearch/README.md)).

## The accelerator is never a dependency

If `MEILI_URL` is unset, or Meilisearch is down or slow, `musicmeta` is plain
MusicBrainz — same happy path, same latency (write-back is fire-and-forget).
Meilisearch only makes search **faster and better-ranked**; it is never required
to serve a result. So a Meilisearch outage degrades ranking, it does not take the
addon down.

## Build prerequisite (know this before Railway's native builder)

`musicmeta` depends on `@p2p-songs/addon-sdk` via an unpublished `link:` to a
**sibling checkout**, so the Docker build context must contain both `addon-sdk/`
and `addons/` (the compose file and `musicmeta.Dockerfile` assume the parent dir).
Single-repo hosts can't see the sibling — deploy the **prebuilt image**, or wait
for the SDK to be published and flip the dep to a version (on the roadmap). Full
detail in [`railway/README.md`](./railway/README.md).

## Contents

- [`musicmeta.Dockerfile`](./musicmeta.Dockerfile) — the addon image (parent context)
- [`docker-compose.yml`](./docker-compose.yml) — Tier 0 full stack
- [`railway/`](./railway/) — the managed two-service setup
- [`meilisearch/`](./meilisearch/) — config + off-box backups
- [`cloudflare/`](./cloudflare/) — cache rule, rate limit, bot/DDoS
