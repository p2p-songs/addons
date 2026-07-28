# bitbop — container image for the hosted stream-debrid addon.
#
# IMPORTANT: build context is the **p2p-songs parent directory** that contains
# both `addon-sdk/` and `addons/` (the documented sibling layout), because bitbop
# depends on the SDK through an unpublished `link:` path, exactly like musicmeta:
#
#   docker build -f addons/deploy/bitbop.Dockerfile -t bitbop .
#
# Single-repo hosts (Railway's native Dockerfile builder) cannot see the sibling
# SDK — build here where both trees exist, push the image, and point Railway at
# it. See deploy/railway/README.md (same prerequisite as musicmeta).
#
# Runtime posture (the whole reason this addon is careful): it is deployed
# PUBLIC, so it stays in public-safe indexer mode — it never sets
# BITBOP_ALLOW_PRIVATE_INDEXERS. A public instance that reached private/loopback
# destinations would be an SSRF proxy (audit A-011). The indexer it queries must
# therefore be a public https URL (a public Prowlarr), which is the shared-setup
# arrangement. There are no credential env vars: every debrid key comes from the
# caller's own /configure config (Plan §3).

# ---- build stage: build the SDK, then the addons workspace ----
# Pinned to $BUILDPLATFORM so the compile runs natively on the builder's arch
# (no QEMU): the runtime deps are pure JS, so artifacts are arch-independent and
# the amd64 runtime below just copies them (arm64 Mac → amd64 image).
FROM --platform=$BUILDPLATFORM node:22-slim AS build
ENV CI=1
RUN corepack enable
WORKDIR /app

# The SDK (protocol + sdk) first; bitbop's `link:` path resolves to
# /app/addon-sdk/packages/sdk once both trees sit side by side under /app.
COPY addon-sdk/ ./addon-sdk/
RUN cd addon-sdk && pnpm install --frozen-lockfile && pnpm -r build

# Then the addons workspace (musicbrainz + bitbop and the rest).
COPY addons/ ./addons/
RUN cd addons && pnpm install --frozen-lockfile && pnpm -r build

# ---- runtime stage: only what's needed to run bitbop ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7003
WORKDIR /app
# Copy both trees so pnpm's symlinked node_modules (incl. the linked SDK) resolve.
COPY --from=build /app/addon-sdk/ ./addon-sdk/
COPY --from=build /app/addons/ ./addons/
WORKDIR /app/addons/packages/bitbop
EXPOSE 7003
# /manifest.json is a cheap, always-200 liveness endpoint (no config needed).
CMD ["node", "dist/serve.js"]
