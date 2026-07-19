# @p2p-songs/stream-legal

A zero-config p2p-songs **stream** addon. Given a `mbid:recording:<uuid>`, it
resolves the song to direct, playable `https` URLs from a **fixed set of
Creative-Commons / public-domain catalogs** — never an open proxy.

Built on [`@p2p-songs/addon-sdk`](../../../addon-sdk/packages/sdk).

## How it resolves a recording

1. **Metadata lookup** — the recording id → "Artist – Title" (+ duration) via
   MusicBrainz. (A stream addon only receives an id, so it must discover what to
   search for — its own version of Torrentio resolving an IMDb id.)
2. **Search the allowlist** — every registered source is searched in parallel;
   a failing source is isolated and never sinks the response.
3. **Rank** — candidates are scored against the intended recording (title/artist
   similarity + duration proximity); weak matches and any non-`https` URL are
   dropped, so it won't serve an unrelated track.
4. **Map** — the survivors become protocol stream objects.

## Sources (the fixed allowlist)

- **Internet Archive** — open, key-less. Always on.
- **Jamendo** — CC-licensed catalog; joins the allowlist only when a
  `JAMENDO_CLIENT_ID` (an operator app credential, not a per-user secret) is set.

There is no mechanism to add a source from a request — the addon can never be
pointed at an arbitrary catalog (Review Checklist §5). Free Music Archive retired
its public API and is intentionally not wired up.

## Run

```sh
pnpm build
PORT=7001 node dist/serve.js
# optionally: JAMENDO_CLIENT_ID=… PORT=7001 node dist/serve.js
# install URL: http://127.0.0.1:7001/manifest.json
```

## Library use

`createStreamLegalAddon({ metadata, sources })` returns an SDK `AddonInterface`;
`metadata` and `sources` are injected, so the resolver is fully unit-testable
without network. See `src/index.ts` for the exported API.

Build: `pnpm build` · Test: `pnpm test` · Typecheck: `pnpm typecheck`.
