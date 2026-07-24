#!/usr/bin/env sh
# Ship Meilisearch snapshots off-box to S3-compatible object storage
# (Cloudflare R2 — free egress — or Backblaze B2, or AWS S3).
#
# Meilisearch writes a point-in-time snapshot every MEILI_SCHEDULE_SNAPSHOT
# seconds into <db>/snapshots. This just syncs that directory off the box.
# Snapshots are tiny (~30 MB per 10M docs), and the index is derived data, so a
# restore only saves a slow cold re-warm from MusicBrainz — belt and suspenders.
#
# Run from cron on the host, e.g. hourly:
#   0 * * * * S3_BUCKET=s3://p2p-songs-meili S3_ENDPOINT=https://<acct>.r2.cloudflarestorage.com /path/to/backup.sh
#
# Requires the AWS CLI, with R2/B2 credentials in the environment or ~/.aws.
set -eu

: "${S3_BUCKET:?set S3_BUCKET, e.g. s3://p2p-songs-meili-backups}"
: "${S3_ENDPOINT:?set S3_ENDPOINT, e.g. https://<acct>.r2.cloudflarestorage.com}"

# Compose names the volume "<project>_meili_data"; the snapshots live under it.
# Override SNAP_DIR to match your host (docker volume inspect <name> shows it).
SNAP_DIR="${SNAP_DIR:-/var/lib/docker/volumes/deploy_meili_data/_data/snapshots}"

if [ ! -d "$SNAP_DIR" ]; then
  echo "backup.sh: snapshot dir not found: $SNAP_DIR" >&2
  echo "  set SNAP_DIR (docker volume inspect deploy_meili_data)" >&2
  exit 1
fi

aws s3 sync "$SNAP_DIR" "$S3_BUCKET/snapshots/" \
  --endpoint-url "$S3_ENDPOINT" \
  --only-show-errors

echo "backup.sh: synced $(find "$SNAP_DIR" -type f | wc -l | tr -d ' ') snapshot file(s) to $S3_BUCKET/snapshots/"
