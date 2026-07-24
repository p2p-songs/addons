# catalog-importer — the runtime **import** half of the metadata pipeline.
#
# It fetches the latest golden NDJSON from R2, verifies its checksum, and does a
# zero-downtime reindex into Meilisearch (staging index → atomic swap). It must
# run **inside the private network** with Meili, because Meili is never exposed —
# on Railway that means a service in the same project/environment as Meili, run on
# a cron a little after the nightly build+publish Action.
#
# Unlike musicmeta, catalog-builder has **no `link:` dependency on the SDK** (its
# only runtime dep is the pure-JS AWS S3 client), so this builds from the `addons`
# repo alone — the build context is this repo root, not the p2p-songs parent:
#
#   docker build -f deploy/catalog-importer.Dockerfile -t catalog-importer .
#
# Run it (one-shot; exits when the import completes):
#
#   docker run --rm \
#     -e R2_ACCOUNT_ID=… -e R2_ACCESS_KEY_ID=… -e R2_SECRET_ACCESS_KEY=… \
#     -e MEILI_URL=http://meilisearch.railway.internal:7700 -e MEILI_API_KEY=… \
#     catalog-importer

# ---- build stage: pinned to $BUILDPLATFORM so the compile runs natively (no
# QEMU); catalog-builder's deps are pure JS, so the amd64 runtime just copies the
# arch-independent artifacts (same trick as musicmeta.Dockerfile). ----
FROM --platform=$BUILDPLATFORM node:22-slim AS build
ENV CI=1
RUN corepack enable
WORKDIR /app
COPY . ./
# Filtered install: only catalog-builder's subtree (no musicmeta, no SDK link).
RUN pnpm install --filter @p2p-songs/catalog-builder... --frozen-lockfile
RUN pnpm --filter @p2p-songs/catalog-builder build

# ---- runtime stage ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Copy the whole tree so pnpm's symlinked node_modules resolve at runtime.
COPY --from=build /app/ ./
WORKDIR /app/packages/catalog-builder
# One-shot: fetch latest from R2 → verify → zero-downtime reindex → exit.
CMD ["node", "dist/cli.js", "import"]
