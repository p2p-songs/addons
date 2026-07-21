import { describe, it, expect } from "vitest";
import { encodeConfig, decodeConfig } from "@p2p-songs/addon-sdk";
import { parseConfig, redactConfig, bitbopConfigSchema } from "../src/config.js";
import { renderBitbopConfigurePage } from "../src/configure-page.js";
import { manifest } from "../src/manifest.js";

const valid = {
  debrid: { provider: "realdebrid", apiKey: "RD-SECRET-KEY-123" },
  indexers: [{ url: "https://jackett.example/api/v2.0/indexers/all/results/torznab", apiKey: "IX-SECRET-456" }],
};

describe("config", () => {
  it("round-trips through the SDK's URL-segment encoding", () => {
    const parsed = parseConfig(decodeConfig(encodeConfig(valid)));
    expect(parsed?.debrid.apiKey).toBe("RD-SECRET-KEY-123");
    expect(parsed?.indexers).toHaveLength(1);
  });

  it("applies defaults so a minimal config is complete", () => {
    const parsed = parseConfig(valid);
    expect(parsed?.cachedOnly).toBe(true);
    expect(parsed?.maxResults).toBe(8);
    expect(parsed?.preferFormats).toEqual(["FLAC", "MP3"]);
  });

  it("rejects a config with no debrid credential — there is no operator fallback", () => {
    expect(parseConfig({ ...valid, debrid: { provider: "realdebrid" } })).toBeUndefined();
    expect(parseConfig({ ...valid, debrid: { provider: "realdebrid", apiKey: "" } })).toBeUndefined();
    expect(parseConfig({ indexers: valid.indexers })).toBeUndefined();
  });

  it("rejects a config with no indexers — discovery has nothing to query", () => {
    expect(parseConfig({ ...valid, indexers: [] })).toBeUndefined();
  });

  it("rejects an unknown debrid provider rather than guessing one", () => {
    expect(parseConfig({ ...valid, debrid: { provider: "totallyreal", apiKey: "k" } })).toBeUndefined();
  });

  it("returns undefined instead of throwing, so no zod message can quote the key", () => {
    // A thrown ZodError's message embeds the received value; the router turns
    // our `undefined` into a flat 400 (Checklist §6a: opaque error bodies).
    const bad = { debrid: { provider: "realdebrid", apiKey: 12345 }, indexers: valid.indexers };
    expect(() => parseConfig(bad)).not.toThrow();
    expect(parseConfig(bad)).toBeUndefined();

    const thrown = bitbopConfigSchema.safeParse(bad);
    expect(thrown.success).toBe(false);
  });
});

describe("redactConfig", () => {
  it("keeps no key material and no indexer URLs", () => {
    const config = parseConfig(valid)!;
    const serialized = JSON.stringify(redactConfig(config));

    expect(serialized).not.toContain("RD-SECRET-KEY-123");
    expect(serialized).not.toContain("IX-SECRET-456");
    expect(serialized).not.toContain("jackett.example/api");
    expect(serialized).toContain("realdebrid"); // provider name is not a secret
  });

  it("keeps the indexer label so diagnostics stay useful", () => {
    const config = parseConfig({
      ...valid,
      indexers: [{ ...valid.indexers[0]!, name: "my-jackett" }],
    })!;
    expect(JSON.stringify(redactConfig(config))).toContain("my-jackett");
  });
});

describe("configure page", () => {
  it("never echoes key material back into the HTML", () => {
    const html = renderBitbopConfigurePage({ config: valid, manifest });
    expect(html).not.toContain("RD-SECRET-KEY-123");
    expect(html).not.toContain("IX-SECRET-456");
  });

  it("prefills only the shape of an existing install", () => {
    const html = renderBitbopConfigurePage({
      config: { ...valid, indexers: [{ ...valid.indexers[0]!, name: "my-jackett" }] },
      manifest,
    });
    expect(html).toContain("my-jackett");
    expect(html).toContain('value="realdebrid" selected');
  });

  it("carries a strict CSP with a per-render nonce and no unsafe-inline", () => {
    const html = renderBitbopConfigurePage({ manifest });
    expect(html).toContain("default-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).not.toContain("unsafe-inline");
    expect(html).not.toContain("unsafe-eval");

    const nonce = /script-src 'nonce-([^']+)'/.exec(html)?.[1];
    expect(nonce).toBeTruthy();
    expect(html).toContain(`<script nonce="${nonce}">`);

    const second = /script-src 'nonce-([^']+)'/.exec(renderBitbopConfigurePage({ manifest }))?.[1];
    expect(second).not.toBe(nonce); // fresh per render
  });

  it("has no form action and loads nothing from the network", () => {
    const html = renderBitbopConfigurePage({ manifest });
    expect(html).not.toMatch(/<form[^>]*action=/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toMatch(/<link[^>]+href="https?:/i);
  });

  it("tells the user the install URL is a secret", () => {
    const html = renderBitbopConfigurePage({ manifest });
    expect(html).toMatch(/contains your debrid key/i);
  });
});

describe("manifest", () => {
  it("requires configuration, so the router fails closed", () => {
    expect(manifest.behaviorHints?.configurationRequired).toBe(true);
    expect(manifest.behaviorHints?.configurable).toBe(true);
  });

  it("declares no p2p behaviour — the player only ever sees a resolved url", () => {
    expect(manifest.behaviorHints?.p2p).toBe(false);
  });

  it("is stream-only: no catalog or meta resource to aggregate other addons", () => {
    expect(manifest.resources).toEqual(["stream"]);
    expect(manifest.catalogs).toEqual([]);
  });
});
