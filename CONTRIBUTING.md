# Contributing to AIConnect

Thanks for your interest in improving AIConnect.

## Project layout

- `extension/` — the Thunderbird MailExtension (manifest v2). `rpc.js` holds every
  operation the CLI/MCP can invoke; `background.js` is the WebSocket client + ongoing-rule
  engine; `options.html`/`options.js` is the settings page.
- `src/` — the Node CLI (`cli.js`), the local WebSocket `bridge.js` (hub/peer + port
  fallback), the shared `api.js`, the `suggest.js` heuristics, `mcp.js` (MCP server), and
  `format.js` (human output).
- `scripts/build-xpi.js` — zips `extension/` into `dist/aiconnect-<version>.xpi` (no deps).
- `skill/aiconnect/SKILL.md` — instructions for AI assistants.
- `test/` — `bridge.test.js` runs the bridge + a mock extension end to end.

## Dev loop

```
npm install
npm test                      # bridge + scan + suggest + rules + archive + auth
npm run build:xpi             # dist/aiconnect-<version>.xpi
node scripts/build-xpi.js     # same
```

Load the extension unpacked during development via Thunderbird → Add-ons → gear →
*Debug Add-ons* → *Load Temporary Add-on* → `extension/manifest.json`, or install the
built `.xpi`. Pair with `node src/cli.js pair` and check `node src/cli.js status`.

## Conventions

- No runtime dependencies in the extension; the CLI keeps its deps minimal
  (`ws`, `commander`, `zod`, the MCP SDK).
- Every RPC handler lives in `extension/rpc.js` and returns plain JSON.
- Long-running operations must stay resumable and bounded — see `rules.run`
  (cursor + move cap) — so they finish under a host's response window on huge inboxes.
- Never commit personal data: mailbox plans, scans, tokens, and `.aiconnect/` are
  git-ignored. Keep it that way.

## Versioning

Bump the version in `extension/manifest.json`, `package.json`, `extension/rpc.js`
(`AIC.VERSION`) and `src/mcp.js` together, then rebuild the xpi and tag a release.
