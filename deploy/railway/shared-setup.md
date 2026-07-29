# Railway shared-setup runbook — Prowlarr + Bitbop + PHONO

Host the **stream plane** (Prowlarr + Bitbop) and the **player** on Railway so a
friend can try the whole thing with nothing running on your laptop. Assumes the
**metadata plane is already deployed** (musicmeta + Meilisearch + catalog-importer
— see [`README.md`](./README.md)); you only need its public **musicmeta** URL here.

This is the **shared-setup / Shape-A** model (`.github/docs/DEPLOYMENT.md`): one
Bitbop install URL that you generate and hand out. Everyone you share it with
plays through **your** Real-Debrid account and **your** Prowlarr. That URL is a
secret — it carries both keys. (Want friends to bring their *own* debrid key with
Prowlarr kept private? That's the unbuilt "Shape B"; say so and it's a follow-up.)

```
 friend ─▶ PHONO (public) ─▶ musicmeta (public, already up) ─▶ Meilisearch (private)
                │
                └─ pastes your Bitbop URL ─▶ Bitbop (public, public-safe)
                                                   └─ Torznab ─▶ Prowlarr (public, API-key gated)
```

Prereqs: Docker locally, a container registry you can push to (e.g. `ghcr.io`),
the Railway CLI or dashboard, and your hosted **musicmeta** manifest URL.

> **Why prebuilt images?** Bitbop and the player depend on the sibling
> `addon-sdk` through unpublished `link:` paths, which Railway's native builder
> can't see (same reason musicmeta ships prebuilt). Build locally from the
> **p2p-songs parent dir**, push, and point Railway at the image.

---

## 1. Prowlarr (public, API-key gated, with a volume)

1. **New Service → Docker Image →** `linuxserver/prowlarr:latest` (the Docker Hub
   image, [`hub.docker.com/r/linuxserver/prowlarr`](https://hub.docker.com/r/linuxserver/prowlarr);
   `lscr.io/linuxserver/prowlarr` is LinuxServer's own registry alias for the
   exact same image — either works, use whichever Railway accepts cleanly).
2. Attach a **volume** mounted at `/config` (its DB + indexer config live here).
   Prowlarr listens on **9696** — Railway detects it; if not, set the service's
   target port to `9696`.
3. Generate a **public domain** for it.
4. Open the domain, complete first-boot **authentication setup** (set a username/
   password — Prowlarr forces auth; that plus the API key is what makes a public
   instance acceptable).
5. Copy the **API key** from Settings → General → Security.
6. Re-add the indexer set (a fresh Prowlarr mints its own key, so we provision
   rather than migrate the DB):

   ```sh
   PROWLARR_URL=https://<prowlarr-domain> \
   PROWLARR_KEY=<prowlarr-api-key> \
   node addons/deploy/prowlarr/provision-indexers.mjs
   ```

   Adds the six public indexers (TPB, Knaben, TorrentsCSV, LimeTorrents, Torrent
   Downloads, MixtapeTorrent) and prints each one's Torznab URL.

## 2. Bitbop (public, public-safe)

```sh
# from the p2p-songs parent dir (contains addon-sdk/ and addons/)
docker build -f addons/deploy/bitbop.Dockerfile -t ghcr.io/<you>/bitbop:latest .
docker push ghcr.io/<you>/bitbop:latest
```

- **New Service → Deploy from Docker Image →** `ghcr.io/<you>/bitbop:latest`.
- **Variables:** `HOST=0.0.0.0` (Railway can't route loopback). `PORT` is
  injected. **Do NOT set `BITBOP_ALLOW_PRIVATE_INDEXERS`** — this instance is
  public, so it must stay in public-safe mode (A-011); that's exactly why
  Prowlarr got a public https domain in step 1.
- **Health check** `/manifest.json` (see `railway/bitbop.railway.json`).
- Generate a **public domain**.

## 3. PHONO player (public static)

```sh
# from the p2p-songs parent dir (contains addon-sdk/, addons/, player/)
docker build -f player/deploy/Dockerfile \
  --build-arg VITE_DEFAULT_METADATA_ADDON_URL=https://<your-musicmeta>/manifest.json \
  -t ghcr.io/<you>/phono:latest .
docker push ghcr.io/<you>/phono:latest
```

- **New Service → Deploy from Docker Image →** `ghcr.io/<you>/phono:latest`.
- Caddy serves the static build on Railway's `$PORT`; generate a **public
  domain**. The hosted musicmeta is baked in as the default metadata addon, so
  search works the moment the friend opens the page. No stream addon is bundled
  (neutrality §11) — that's the Bitbop URL below.

## 4. Generate the shared Bitbop install URL

```sh
RD_KEY=<your-real-debrid-key> \
PROWLARR_URL=https://<prowlarr-domain> \
PROWLARR_KEY=<prowlarr-api-key> \
BITBOP_URL=https://<bitbop-domain> \
node addons/deploy/bitbop/gen-install-url.mjs
```

It reads the indexer list from Prowlarr and prints
`https://<bitbop-domain>/<config>/manifest.json`. **This is the secret you share.**

## 5. Your friend

1. Open the **PHONO** domain (search already works — musicmeta is pre-installed).
2. **Addons → paste the Bitbop URL → install.**
3. Play something. Well-seeded albums resolve fast; thin ones fail quickly and
   honestly (the stall-detection).

## Redeploys

Rebuild + push the image and Railway redeploys. Prowlarr's data persists on its
volume. If you rotate the Real-Debrid key or change indexers, just re-run step 4
and re-share the new URL (the old one keeps working until the key is revoked).
