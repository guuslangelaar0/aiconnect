# AIConnect — Thunderbird extension + CLI + MCP server

[![Release](https://img.shields.io/github/v/release/guuslangelaar0/aiconnect?sort=semver)](https://github.com/guuslangelaar0/aiconnect/releases)
[![Release workflow](https://img.shields.io/github/actions/workflow/status/guuslangelaar0/aiconnect/release.yml?label=build)](https://github.com/guuslangelaar0/aiconnect/actions/workflows/release.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Thunderbird 128+](https://img.shields.io/badge/Thunderbird-128%2B-0a84ff?logo=thunderbird&logoColor=white)](https://www.thunderbird.net/)
[![Node 18+](https://img.shields.io/badge/Node-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-server-6b4fbb)](https://modelcontextprotocol.io/)
[![Built with Claude Code](https://img.shields.io/badge/built%20with-Claude%20Code-d97757)](https://claude.com/claude-code)

Let AI tools (Claude Code, Claude Desktop, Cowork, anything that speaks MCP) and your shell read, organize
and automate your Thunderbird accounts. Three parts:

- **Thunderbird extension** (`extension/`): executes commands inside Thunderbird. Dials a local WebSocket,
  never listens, never talks to the internet.
- **`aiconnect` CLI** (`src/`): hosts that WebSocket on `127.0.0.1:47800`, exposes commands, and can run as
  an **MCP server** (`aiconnect mcp`).
- **Skill** (`skill/aiconnect/SKILL.md`): tells an AI assistant how to use it safely.

Everything runs on your machine. The only credential is a random pairing token so no other local process
can drive your mailbox.

## Install

Not on npm yet — install from this repo.

```
git clone https://github.com/guuslangelaar0/aiconnect.git
cd aiconnect
npm install
npm link                            # optional: puts `aiconnect` on your PATH
```

Without `npm link`, run any command as `node dist/aiconnect.mjs <cmd>` (a prebuilt single-file
bundle) or `node src/cli.js <cmd>`.

```
aiconnect pair                      # prints port + token; stored in ~/.aiconnect/config.json
aiconnect build-xpi                 # writes dist/aiconnect-<version>.xpi
```

Install the extension in Thunderbird: Add-ons and Themes → gear icon → *Install Add-on From File…*
→ pick `dist/aiconnect-<version>.xpi` (or download it from the repo's Releases). Click the AIConnect
toolbar button (or Add-ons → AIConnect → Preferences), enter the token, Save.

```
aiconnect status                    # "connected: AIConnect extension 0.2.2 in Thunderbird 155.0.1"
```

For development, load `extension/` via Add-ons → gear → *Debug Add-ons* → *Load Temporary Add-on*.

> Publishing to npm (so `npm i -g aiconnect` works) is planned but not done yet.

## Use

```
aiconnect accounts --counts                     # accounts and folder trees
aiconnect scan -o scan.json                     # inventory + inbox sender/domain/year analysis
aiconnect suggest scan.json --rules-out rules.json --lang nl
aiconnect rules dry-run rules.json              # counts only
aiconnect rules apply rules.json --yes          # move existing mail
aiconnect rules save rules.json                 # extension sorts new mail from now on
aiconnect archive me@example.com --to "Inbox/Archive" --by-year --older-than 365        # dry run
aiconnect archive me@example.com --to "Inbox/Archive" --by-year --older-than 365 --yes
aiconnect messages search --from bunq --since 2026-01-01
aiconnect messages read 12345
aiconnect messages move 12345 12346 --to "me@example.com:Inbox/Receipts"
```

Every command accepts `--json`. Folder references are `account:Path/By/Names`; some IMAP servers nest
all folders under `Inbox/`, use the paths `aiconnect folders list` shows.

### As an MCP server

```json
{ "mcpServers": { "aiconnect": { "command": "aiconnect", "args": ["mcp"] } } }
```

Tools: `status`, `list_accounts`, `list_folders`, `create_folder`, `scan`, `suggest`, `list_messages`,
`search_messages`, `read_message`, `move_messages`, `update_messages`, `delete_messages`, `rules_dry_run`,
`rules_apply`, `rules_save`, `rules_get`, `archive`. Destructive tools require `confirm: true`.

### Rules

```json
[{ "account": "me@example.com", "field": "from", "patterns": ["medium.com"], "dest": "Inbox/News/Medium" }]
```

`field` is `from`, `subject`, `any` or `to`; patterns are case-insensitive substrings; first match wins;
`dest` is created if missing. Saved rules are applied by the extension to new mail in that account's inbox.

## How `suggest` thinks

Inbox should hold only what needs a human. Automated mail is classified by sender address, display name
and sample subjects into: receipts, orders, newsletters, notifications, social, dev, jobs, government,
finance, housing, family. Senders above `--vendor-threshold` messages per year get their own sub-folder.
Existing folders are reused when their name is a known synonym (`Boekhouding` → receipts,
`Nieuwsbrieven` → newsletters, …). Old mail is archived per year (Gmail: into All Mail). Nothing is ever
deleted by a suggestion. Use `--probe` on `scan` to check `List-Unsubscribe` headers for better
newsletter detection and an unsubscribe list.

## Protocol

JSON over WebSocket. Extension → bridge: `{"type":"hello","token":…}`. Bridge → extension:
`{"id":1,"method":"messages.move","params":{…}}`; reply `{"id":1,"result":…}` or `{"id":1,"error":{"message":…}}`;
progress `{"method":"progress","params":{"id":1,"done":100,"total":500,"label":"moving"}}`.
Methods: `ping`, `accounts.list`, `folders.list|info|ensure|rename|delete`, `messages.list|query|get|read|move|copy|delete|archive|update`,
`tags.list`, `scan.folder`, `rules.get|set|run`, `archive.run`. See `extension/rpc.js`.

## Requirements

Thunderbird 128+ (tested on 155), Node 18+.

## License

MIT

## Credits

Built by Guus Langelaar ([Devidee B.V.](https://devidee.nl)) with Claude Code.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
