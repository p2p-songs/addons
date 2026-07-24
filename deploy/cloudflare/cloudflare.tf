# Optional: the musicmeta edge (cache rule + rate limit) as Terraform.
# The dashboard steps in README.md are authoritative — Cloudflare provider syntax
# drifts across major versions (this targets provider v4's ruleset engine).
# Fill in zone_id and the hostname; store the API token out of band.

terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 4"
    }
  }
}

variable "zone_id" { type = string }
variable "musicmeta_host" {
  type    = string
  default = "musicmeta.example.com"
}

# 1. Make catalog/meta/manifest responses eligible for the edge cache,
#    respecting the origin's Cache-Control (secret-bearing paths stay no-store).
resource "cloudflare_ruleset" "musicmeta_cache" {
  zone_id = var.zone_id
  name    = "musicmeta cache"
  kind    = "zone"
  phase   = "http_request_cache_settings"

  rules {
    action = "set_cache_settings"
    action_parameters {
      cache = true
      edge_ttl {
        mode = "respect_origin"
      }
    }
    expression = <<-EOT
      (http.host eq "${var.musicmeta_host}") and (
        starts_with(http.request.uri.path, "/catalog/") or
        starts_with(http.request.uri.path, "/meta/") or
        http.request.uri.path eq "/manifest.json"
      )
    EOT
    enabled     = true
    description = "Cache musicmeta's public, per-user-identical responses at the edge"
  }
}

# 2. One rate-limit rule (free plan allows one), per client IP.
resource "cloudflare_ruleset" "musicmeta_ratelimit" {
  zone_id = var.zone_id
  name    = "musicmeta rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    action = "managed_challenge"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = 120
      mitigation_timeout  = 60
    }
    expression  = "(http.host eq \"${var.musicmeta_host}\")"
    enabled     = true
    description = "Challenge IPs exceeding 120 req/min to musicmeta"
  }
}
