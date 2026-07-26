import { describe, it, expect } from "vitest";
import { renderBitbopConfigurePage } from "../src/configure-page.js";
import { bitbopConfigSchema } from "../src/config.js";
import { manifest } from "../src/manifest.js";

const render = (config?: Record<string, unknown>): string =>
  renderBitbopConfigurePage({ config, manifest, allowPrivateIndexers: false });

describe("configure page — the disclosed behavior matches the generated config", () => {
  it("does not describe the retired cached-only behavior", () => {
    // A-013: the page once promised "only returns torrents your account has
    // already cached" while the generated config downloads uncached tracks. The
    // consent surface must not resurrect that false promise.
    const html = render();
    expect(html).not.toMatch(/only returns torrents your debrid account has/i);
    // It must disclose the credentialed, state-changing action plainly.
    expect(html).toMatch(/download/i);
    expect(html).toMatch(/whole album/i);
  });

  it("checkbox default matches the schema default (both on)", () => {
    // The defect was a drift between what the page shows and what schema parsing
    // applies. Tie them together: whatever the schema defaults to for an install
    // that omits the field is what the page must show pre-checked.
    const applied = bitbopConfigSchema.parse({
      debrid: { provider: "realdebrid", apiKey: "k" },
      indexers: [{ url: "https://ix.example/torznab", apiKey: "k" }],
    }).downloadUncached;
    expect(applied).toBe(true);

    const checkbox = /<input id="downloadUncached"[^>]*>/.exec(render())?.[0] ?? "";
    expect(/\bchecked\b/.test(checkbox)).toBe(applied);
  });

  it("reflects a stored downloadUncached:false as an unchecked box", () => {
    const checkbox =
      /<input id="downloadUncached"[^>]*>/.exec(
        render({
          debrid: { provider: "realdebrid", apiKey: "k" },
          indexers: [{ url: "https://ix.example/torznab", apiKey: "k" }],
          downloadUncached: false,
        }),
      )?.[0] ?? "";
    expect(/\bchecked\b/.test(checkbox)).toBe(false);
  });
});
