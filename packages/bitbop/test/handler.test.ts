import { describe, it, expect } from "vitest";
import { createRouter, encodeConfig } from "@p2p-songs/addon-sdk";
import type { MusicBrainzClient } from "@p2p-songs/musicbrainz";
import { createBitbopAddon } from "../src/handler.js";
import type { ResolveDeps } from "../src/resolve.js";
import type { BitbopConfig } from "../src/config.js";
import type { TrackContext } from "../src/metadata.js";
import type { TorrentCandidate } from "../src/indexers/types.js";

const RID = "mbid:recording:11111111-1111-1111-1111-111111111111";

// Bitbop only uses musicbrainz through the injected metadata lookup in these
// tests, so a stub client is never actually called.
const stubMb = {} as MusicBrainzClient;

const track: TrackContext = { artist: "Daft Punk", title: "Digital Love", hasAlbumContext: false };
const HASH = "0123456789abcdef0123456789abcdef01234567";
const cand: TorrentCandidate = { indexer: "fake", title: "Daft Punk - Discovery [FLAC]", infoHash: HASH, format: "FLAC" };
const files = [{ id: "0", path: "Digital Love.flac", sizeBytes: 50_000_000 }];

function addonWith(buildResolveDeps: (c: BitbopConfig) => ResolveDeps | undefined, onError?: BitbopParams["onError"]) {
  return createBitbopAddon({ musicbrainz: stubMb, buildResolveDeps, ...(onError ? { onError } : {}) });
}
type BitbopParams = Parameters<typeof createBitbopAddon>[0];

const okDeps = (): ResolveDeps => ({
  metadata: { resolve: async () => track },
  indexers: [{ name: "fake", search: async () => [cand] }],
  provider: {
    id: "realdebrid",
    checkCache: async () => ({ cached: true, files }),
    resolveFile: async () => ({ url: "https://rd.example/dl/digital-love.flac", filename: "Digital Love.flac" }),
  },
});

const streamPath = (cfg: object): string => `/${encodeConfig(cfg)}/stream/track/${encodeURIComponent(RID)}.json`;
const validCfg = { debrid: { provider: "realdebrid", apiKey: "RDKEY" }, indexers: [{ url: "https://ix.example/t", apiKey: "IX" }] };

describe("bitbop handler over the SDK router", () => {
  it("resolves a stream for a configured request", async () => {
    const router = createRouter(addonWith(okDeps));
    const res = await router({ method: "GET", url: streamPath(validCfg) });
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body!);
    expect(body.streams).toHaveLength(1);
    expect(body.streams[0].url).toBe("https://rd.example/dl/digital-love.flac");
  });

  it("fails closed: an unconfigured stream request is a 400, handler never runs", async () => {
    let ran = false;
    const router = createRouter(
      addonWith(() => {
        ran = true;
        return okDeps();
      }),
    );
    const res = await router({ method: "GET", url: `/stream/track/${encodeURIComponent(RID)}.json` });
    expect(res.status).toBe(400);
    expect(ran).toBe(false);
  });

  it("a configured request is cached no-store (the segment holds the debrid key)", async () => {
    const router = createRouter(addonWith(okDeps));
    const res = await router({ method: "GET", url: streamPath(validCfg) });
    expect(res.headers["Cache-Control"]).toMatch(/no-store/);
    expect(res.headers["Cache-Control"]).toMatch(/private/);
  });

  it("an upstream outage becomes an opaque 500, and the diagnostics hook gets only redacted config", async () => {
    let captured: { message: string; config: Record<string, unknown> } | undefined;
    const router = createRouter(
      addonWith(
        () => ({
          metadata: { resolve: async () => track },
          indexers: [{ name: "fake", search: async () => { throw new Error("indexer down"); } }],
          provider: okDeps().provider,
        }),
        (info) => (captured = info),
      ),
    );
    const res = await router({ method: "GET", url: streamPath(validCfg) });
    expect(res.status).toBe(500);
    expect(res.body).not.toContain("RDKEY"); // opaque body, no credential
    const diag = JSON.stringify(captured?.config);
    expect(diag).not.toContain("RDKEY"); // debrid key redacted
    expect(diag).not.toContain("IX"); // indexer key redacted
    expect(diag).not.toContain("ix.example/t"); // full indexer URL redacted (a URL can itself carry a key)
    // the bare host may remain as a diagnostic label — it is not the credential
  });

  it("a genuine no-match is a cached, empty 200", async () => {
    const router = createRouter(
      addonWith(() => ({ ...okDeps(), indexers: [{ name: "fake", search: async () => [] }] })),
    );
    const res = await router({ method: "GET", url: streamPath(validCfg) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body!).streams).toEqual([]);
  });
});
