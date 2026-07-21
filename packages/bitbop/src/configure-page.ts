/**
 * Bitbop's `/configure` page.
 *
 * The SDK ships a generic "paste some JSON" page; this replaces it, because
 * this is the one screen in the whole project where a user hands over a real
 * credential and it should behave like it knows that:
 *
 * - **The key never leaves the browser.** The install URL is assembled
 *   client-side and the form has no `action` — nothing is ever POSTed. The page
 *   is rendered by the addon, but the addon never receives what you type here.
 * - **The page says what the URL contains.** The generated URL embeds the key,
 *   which is exactly why it works without an account — and exactly why it must
 *   be treated as a password. Saying so is part of the design, not a footnote.
 * - **Strict CSP with a per-render nonce.** No `unsafe-inline`, no external
 *   origins, nothing fetched. The script that touches the key is the only
 *   script allowed to run (Checklist §7's posture, applied at the addon too).
 */
import { randomBytes } from "node:crypto";
import type { AddonConfig, Manifest } from "@p2p-songs/addon-sdk";

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Render the page. `config` is the currently-installed config when someone
 * revisits `/configure` on a configured install — we prefill the *shape*
 * (provider, indexer names, options) but deliberately **never** re-render key
 * material into the HTML: a page that echoes secrets back is a page that leaks
 * them into browser caches, screenshots, and shoulder-surfing.
 */
export function renderBitbopConfigurePage(ctx: { config?: AddonConfig; manifest: Manifest }): string {
  const nonce = randomBytes(16).toString("base64");
  const name = escapeHtml(ctx.manifest.name);
  const prior = readPrior(ctx.config);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'" />
<meta name="referrer" content="no-referrer" />
<title>Configure ${name}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; --bg:#fbf8f4; --fg:#241c17; --muted:#6b5d52; --line:#e0d6ca; --accent:#c25a20; --warn-bg:#fdf1e7; --card:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#1a1512; --fg:#f0e9e2; --muted:#a2938a; --line:#3a302a; --accent:#e07a3f; --warn-bg:#2b1e15; --card:#231c18; }
  }
  * { box-sizing: border-box; }
  body { font: 15px/1.6 system-ui, -apple-system, sans-serif; background: var(--bg); color: var(--fg);
         max-width: 44rem; margin: 0 auto; padding: 2rem 1rem 4rem; }
  h1 { font-size: 1.6rem; margin: 0 0 .25rem; letter-spacing: -.02em; }
  h2 { font-size: 1rem; margin: 2rem 0 .5rem; text-transform: uppercase; letter-spacing: .08em; color: var(--muted); }
  .sub { color: var(--muted); margin: 0 0 1.5rem; }
  label { display: block; font-weight: 600; margin: .75rem 0 .25rem; font-size: .9rem; }
  input, select { width: 100%; padding: .55rem .7rem; font: inherit; color: var(--fg); background: var(--card);
                  border: 1px solid var(--line); border-radius: .4rem; }
  input:focus, select:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  .hint { color: var(--muted); font-size: .85rem; margin: .25rem 0 0; }
  .row { display: flex; gap: .5rem; flex-wrap: wrap; }
  .row > * { flex: 1 1 12rem; }
  fieldset { border: 1px solid var(--line); border-radius: .5rem; padding: .75rem 1rem 1rem; margin: .75rem 0; background: var(--card); }
  legend { font-weight: 600; font-size: .85rem; padding: 0 .35rem; }
  button { padding: .55rem 1rem; font: inherit; font-weight: 600; cursor: pointer;
           border: 1px solid var(--line); border-radius: .4rem; background: var(--card); color: var(--fg); }
  button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
  .warn { background: var(--warn-bg); border: 1px solid var(--accent); border-radius: .5rem; padding: .75rem 1rem; margin: 1.5rem 0; }
  .warn strong { color: var(--accent); }
  .out { margin-top: 1rem; padding: .85rem 1rem; background: var(--card); border: 1px solid var(--line); border-radius: .5rem; }
  code { font-family: ui-monospace, SFMono-Regular, monospace; font-size: .85rem; word-break: break-all; }
  .err { color: #b3261e; font-weight: 600; }
  .actions { display: flex; gap: .5rem; align-items: center; margin-top: 1.25rem; flex-wrap: wrap; }
</style>
</head>
<body>
<h1>Configure ${name}</h1>
<p class="sub">Bitbop searches <em>your</em> indexers and resolves through <em>your</em> debrid account. It has no account of its own, and stores nothing.</p>

<h2>Debrid account</h2>
<label for="provider">Provider</label>
<select id="provider">
  <option value="realdebrid"${prior.provider === "realdebrid" ? " selected" : ""}>Real-Debrid</option>
  <option value="alldebrid"${prior.provider === "alldebrid" ? " selected" : ""}>AllDebrid</option>
</select>
<label for="apiKey">API key</label>
<input id="apiKey" type="password" autocomplete="off" spellcheck="false" placeholder="your debrid API key" />
<p class="hint">Found in your provider's account settings. Bitbop calls the provider as you — never as a shared account.</p>

<h2>Indexers</h2>
<p class="hint">Torznab endpoints from your own Jackett or Prowlarr instance. Bitbop ships no tracker list.</p>
<div id="indexers"></div>
<button id="addIndexer" type="button">+ Add indexer</button>

<h2>Options</h2>
<div class="row">
  <div>
    <label for="cachedOnly">Results</label>
    <select id="cachedOnly">
      <option value="true"${prior.cachedOnly !== false ? " selected" : ""}>Only what's already cached (recommended)</option>
      <option value="false"${prior.cachedOnly === false ? " selected" : ""}>Include uncached (may not play)</option>
    </select>
  </div>
  <div>
    <label for="maxResults">Max streams</label>
    <input id="maxResults" type="number" min="1" max="20" value="${prior.maxResults}" />
  </div>
</div>

<div class="warn">
  <strong>Your install URL contains your debrid key.</strong>
  That's how it works without an account — and it means the URL is a password.
  Don't post it, share it, or paste it into a public issue. Your player stores it
  as a secret and shows it redacted.
</div>

<div class="actions">
  <button id="go" class="primary" type="button">Generate install URL</button>
  <button id="copy" type="button" hidden>Copy</button>
  <span id="msg" class="err" role="alert"></span>
</div>

<div class="out" id="out" hidden>
  <div><strong>Install URL</strong> — paste this into your player's Addons screen:</div>
  <p><code id="url"></code></p>
</div>

<script nonce="${nonce}">
(function () {
  var priorIndexers = ${JSON.stringify(prior.indexerNames)};

  function indexerRow(name) {
    var fs = document.createElement("fieldset");
    fs.innerHTML =
      '<legend>Indexer</legend>' +
      '<label>Torznab URL</label>' +
      '<input class="ix-url" type="url" placeholder="https://jackett.example/api/v2.0/indexers/all/results/torznab" />' +
      '<div class="row"><div><label>API key</label><input class="ix-key" type="password" autocomplete="off" /></div>' +
      '<div><label>Label (optional)</label><input class="ix-name" type="text" /></div></div>' +
      '<p><button class="ix-remove" type="button">Remove</button></p>';
    if (name) fs.querySelector(".ix-name").value = name;
    fs.querySelector(".ix-remove").addEventListener("click", function () { fs.remove(); });
    return fs;
  }

  var list = document.getElementById("indexers");
  if (priorIndexers.length) priorIndexers.forEach(function (n) { list.appendChild(indexerRow(n)); });
  else list.appendChild(indexerRow(""));
  document.getElementById("addIndexer").addEventListener("click", function () { list.appendChild(indexerRow("")); });

  // base64url of a UTF-8 JSON string, without relying on deprecated unescape().
  function base64url(str) {
    var bytes = new TextEncoder().encode(str);
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
  }

  function fail(text) {
    document.getElementById("msg").textContent = text;
    document.getElementById("out").hidden = true;
    document.getElementById("copy").hidden = true;
  }

  document.getElementById("go").addEventListener("click", function () {
    document.getElementById("msg").textContent = "";

    var apiKey = document.getElementById("apiKey").value.trim();
    if (!apiKey) return fail("Enter your debrid API key.");

    var indexers = [];
    var rows = list.querySelectorAll("fieldset");
    for (var i = 0; i < rows.length; i++) {
      var url = rows[i].querySelector(".ix-url").value.trim();
      var key = rows[i].querySelector(".ix-key").value.trim();
      var nm = rows[i].querySelector(".ix-name").value.trim();
      if (!url && !key) continue;
      if (!url || !key) return fail("Each indexer needs both a URL and an API key.");
      var entry = { url: url, apiKey: key };
      if (nm) entry.name = nm;
      indexers.push(entry);
    }
    if (!indexers.length) return fail("Add at least one indexer — Bitbop has no built-in tracker list.");

    var cfg = {
      debrid: { provider: document.getElementById("provider").value, apiKey: apiKey },
      indexers: indexers,
      cachedOnly: document.getElementById("cachedOnly").value === "true",
      maxResults: Number(document.getElementById("maxResults").value) || 8
    };

    var url = location.origin + "/" + base64url(JSON.stringify(cfg)) + "/manifest.json";
    document.getElementById("url").textContent = url;
    document.getElementById("out").hidden = false;
    var copy = document.getElementById("copy");
    copy.hidden = false;
    copy.onclick = function () {
      navigator.clipboard.writeText(url).then(function () {
        copy.textContent = "Copied";
        setTimeout(function () { copy.textContent = "Copy"; }, 1500);
      });
    };
  });
})();
</script>
</body>
</html>`;
}

/** Prefill shape only — never key material. */
function readPrior(config: AddonConfig | undefined): {
  provider: string;
  cachedOnly: boolean | undefined;
  maxResults: number;
  indexerNames: string[];
} {
  const debrid = config?.["debrid"];
  const provider =
    typeof debrid === "object" && debrid !== null && typeof (debrid as { provider?: unknown }).provider === "string"
      ? (debrid as { provider: string }).provider
      : "realdebrid";

  const rawIndexers = config?.["indexers"];
  const indexerNames = Array.isArray(rawIndexers)
    ? rawIndexers.map((i) => {
        const entry = i as { name?: unknown; url?: unknown };
        if (typeof entry.name === "string") return entry.name;
        if (typeof entry.url === "string") {
          try {
            return new URL(entry.url).host;
          } catch {
            return "";
          }
        }
        return "";
      })
    : [];

  const cachedOnly = typeof config?.["cachedOnly"] === "boolean" ? (config["cachedOnly"] as boolean) : undefined;
  const maxResults = typeof config?.["maxResults"] === "number" ? (config["maxResults"] as number) : 8;

  return { provider, cachedOnly, maxResults, indexerNames };
}
