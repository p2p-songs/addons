# Meilisearch for musicmeta

Meilisearch is the optional search accelerator behind `musicmeta` (read-through /
write-back; see the package README's "Search index" section). It is **stateful**
— always-on, with a persistent volume — which is why it lives on a VPS/GCE box or
a Railway service with a volume, never on a scale-to-zero/serverless runtime.

## What musicmeta stores here

Identity-only `metaPreview` docs — id, name, poster, type. **No hashes, no
sources.** A few hundred bytes each, so the index is small: snapshots run ~30 MB
per 10M docs and reload in seconds. 2–4 GB RAM serves it comfortably; disk (small)
is the real constraint. The heavy "35 GB RAM per 1 GB JSON" figure is the *bulk
indexing* peak — musicmeta never hits it because it warms incrementally, one
search's worth per upsert.

`musicmeta` creates the index and applies its settings itself (searchable /
filterable / ranking, in `meili.ts` `ensureReady()`), so there's nothing to
provision by hand — just run Meilisearch with a master key and point
`MEILI_URL` / `MEILI_API_KEY` at it.

## Configuration

| Env | Value | Why |
|---|---|---|
| `MEILI_MASTER_KEY` | long random string | required in `production`; musicmeta authenticates with it (or a scoped key) |
| `MEILI_ENV` | `production` | enables auth; disables the dev web UI |
| `MEILI_NO_ANALYTICS` | `true` | no telemetry |
| `MEILI_SCHEDULE_SNAPSHOT` | `86400` | a snapshot per day, for `backup.sh` to ship off-box |

**Never expose Meilisearch to the internet.** It sits on the private network
behind `musicmeta` (compose network / `*.railway.internal` / VPC). The master key
is a second line, not the only one.

## Backups

[`backup.sh`](./backup.sh) syncs the snapshot directory to S3-compatible storage
(Cloudflare R2 has free egress). Run it from host cron, or from a small Railway
cron service. Because the index is derived from MusicBrainz, a total loss is a
slow re-warm, not lost data — backups just avoid the cold-start.

Before a Meilisearch **major-version upgrade**, take a `dump` (version-portable),
not just a snapshot:

```sh
curl -X POST 'http://meilisearch:7700/dumps' -H "Authorization: Bearer $MEILI_MASTER_KEY"
```
