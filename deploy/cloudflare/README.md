# Cloudflare edge for musicmeta

`musicmeta` is **default-installed**, so every player hits it: it's both a single
point of failure and an abuse magnet. Cloudflare's **free** plan handles the edge
— DDoS proxy, bot mitigation, rate limiting, and (the big one) an **edge cache on
catalog responses** so a tiny origin barely gets touched.

Put musicmeta's public hostname on Cloudflare (orange-cloud / proxied). If the
origin has no public TLS, use a **Cloudflare Tunnel** from the box instead of
exposing a port — the origin then has no public IP at all.

## 1. The cache rule (the point)

Cloudflare does **not** cache JSON API responses by default — only static
extensions. A Cache Rule makes musicmeta's responses eligible, and they're safe
to cache because catalog/meta results are **public and identical for every user**
(musicmeta is zero-config, so no request carries a secret; the SDK marks any
secret-bearing response `no-store` anyway, and Cloudflare will honour that).

**Dashboard → Caching → Cache Rules → Create rule:**

- **When:** `(http.host eq "musicmeta.example.com") and (starts_with(http.request.uri.path, "/catalog/") or starts_with(http.request.uri.path, "/meta/") or http.request.uri.path eq "/manifest.json")`
- **Then:**
  - Cache eligibility: **Eligible for cache**
  - Edge TTL: **Respect origin** (musicmeta already sends a public `max-age`;
    override to e.g. 1 hour only if you want to decouple from it)
  - Browser TTL: Respect origin

That single rule is what lets popular queries ("justin bieber baby") serve from
the edge nearest each user and keeps the MusicBrainz ≤1 req/sec/IP budget two
layers deep (edge → Meili → MB).

## 2. Rate limiting (free plan allows one rule)

**Dashboard → Security → Rate limiting rules → Create:**

- **When:** `http.host eq "musicmeta.example.com"`
- **Characteristics:** client IP
- **Rate:** e.g. **120 requests / 1 minute**
- **Action:** Managed Challenge (or Block) for the timeout period

Tune to real traffic; catalog search is user-typed, so a legitimate player is
nowhere near 120/min.

## 3. Bot + DDoS

- **Security → Bots → Bot Fight Mode: On** (free tier).
- L3/4 DDoS mitigation is automatic once the hostname is proxied.
- **SSL/TLS mode: Full (strict)** if the origin serves TLS; not needed with a
  Tunnel.

Honest limit: free-tier Bot Fight Mode won't stop a distributed L7 attack with
real browser fingerprints. That's fine at this stage — it stops floods and
scrapers. Revisit Pro ($20/mo) only if you're actually targeted.

## Optional: Terraform

[`cloudflare.tf`](./cloudflare.tf) expresses the cache rule and the rate-limit
rule as code. The dashboard steps above are authoritative; provider syntax drifts
between major versions, so treat the file as a starting point.
