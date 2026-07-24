# musicmeta — container image for the hosted metadata addon.
#
# IMPORTANT: the build context must be the **p2p-songs parent directory** that
# contains both `addon-sdk/` and `addons/` (the documented sibling layout),
# because musicmeta depends on the SDK through an unpublished `link:` path
# (`link:../../../addon-sdk/packages/sdk`). Build it from the parent:
#
#   docker build -f addons/deploy/musicmeta.Dockerfile -t musicmeta .
#
# docker-compose in this directory already sets that context for you.
# Single-repo hosts (Railway's native Dockerfile builder) cannot see the sibling
# SDK — deploy the prebuilt image instead. See deploy/railway/README.md.

# ---- build stage: build the SDK, then the addons workspace ----
# Pinned to $BUILDPLATFORM so the compile runs natively on the builder's arch
# (no QEMU): musicmeta's runtime deps are pure JS (zod-based; esbuild/vitest are
# dev-only), so the artifacts are architecture-independent and the amd64 runtime
# below just copies them. This is what lets an arm64 Mac produce an amd64 image.
FROM --platform=$BUILDPLATFORM node:22-slim AS build
ENV CI=1
RUN corepack enable
WORKDIR /app

# The SDK (protocol + sdk) first; musicmeta's `link:` path resolves to
# /app/addon-sdk/packages/sdk once both trees sit side by side under /app.
COPY addon-sdk/ ./addon-sdk/
RUN cd addon-sdk && pnpm install --frozen-lockfile && pnpm -r build

# Then the addons workspace (musicbrainz + musicmeta).
COPY addons/ ./addons/
RUN cd addons && pnpm install --frozen-lockfile && pnpm -r build

# ---- runtime stage: only what's needed to run musicmeta ----
FROM node:22-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7002
WORKDIR /app
# Copy both trees so pnpm's symlinked node_modules (incl. the linked SDK) resolve.
COPY --from=build /app/addon-sdk/ ./addon-sdk/
COPY --from=build /app/addons/ ./addons/
WORKDIR /app/addons/packages/musicmeta
EXPOSE 7002
# /manifest.json is a cheap, always-200 liveness endpoint.
CMD ["node", "dist/serve.js"]
