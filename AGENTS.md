# AGENTS.md

If you are operating in this repo as the **adversarial reviewer** (e.g.
Codex): read `../.github/docs/ADVERSARIAL_REVIEW_CONTRACT.md` in full
before doing anything else (fallback if that relative path doesn't resolve
in your environment: https://github.com/p2p-songs/.github/blob/main/docs/ADVERSARIAL_REVIEW_CONTRACT.md).
It defines your role, scope, ground rules, finding format, and how to
report back. Don't infer the process from `CLAUDE.md` alone. This repo
(`addons`) contains `bitbop` (the `stream-debrid` role) — the highest-scrutiny addon; read Plan
§2 and §3 before auditing it specifically.

For this repo's scope and specific invariants, see `CLAUDE.md` in this same
directory — applies regardless of which agent/tool is reading it.

If you are the **implementer**, before starting work read the newest-first
audit registry at `../.github/docs/audits/README.md` and its latest report.
It is authoritative for sign-off even if you saw no GitHub issue.
