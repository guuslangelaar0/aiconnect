# AIConnect

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

```
npm i -g aiconnect
aiconnect pair                      # prints port + token; stored in ~/.aiconnect/config.json
aiconnect build-xpi                 # writes dist/aiconnect-<version>.xpi
```

Thunderbird → Add-ons and Themes → gear icon → *Install Add-on From File…* → pick the `.xpi`.
Click the AIConnect toolbar button (or Add-ons → AIConnect → Preferences), enter the port and token, Save.

```
aiconnect status                    # "connected: AIConnect extension 0.1.0 in Thunderbird 155.0.1"
```

For development, load `extension/` via Add-ons → gear → *Debug Add-ons* → *Load Temporary Add-on*.

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
