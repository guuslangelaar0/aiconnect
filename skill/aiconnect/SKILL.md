---
name: aiconnect
description: Read, organize and automate a user's Thunderbird mail through the AIConnect CLI or MCP server (scan inboxes, propose folders and sorting rules, dry-run, apply, archive, save auto-sort rules). Use when the user asks to organize, clean up, sort, filter, triage or analyse their Thunderbird mail, or mentions aiconnect.
---

# AIConnect: Thunderbird for AI tools

AIConnect is a local bridge: a Thunderbird extension dials `ws://127.0.0.1:47800`, hosted by the
`aiconnect` CLI (per command) or by `aiconnect mcp` (long-lived). Nothing leaves the machine unless
you send it somewhere. Everything heavy runs inside Thunderbird; you get summaries.

Two ways to drive it. Prefer MCP tools when they are available in the session; otherwise use the CLI
with `--json` so output is parseable.

| Task | MCP tool | CLI |
|---|---|---|
| connection check | `status` | `aiconnect status` |
| accounts + folder trees | `list_accounts` | `aiconnect accounts --counts --json` |
| inventory + sender analysis | `scan` | `aiconnect scan [account] --days 365 -o scan.json` |
| proposal (folders, rules, archive, unsubscribe) | `suggest` | `aiconnect suggest scan.json --rules-out rules.json` |
| count what rules would move | `rules_dry_run` | `aiconnect rules dry-run rules.json` |
| move existing mail | `rules_apply` (confirm) | `aiconnect rules apply rules.json --yes` |
| auto-sort future mail | `rules_save` | `aiconnect rules save rules.json` |
| archive old inbox mail | `archive` (confirm) | `aiconnect archive <account> --to "Inbox/Archive" --by-year [--yes]` |
| find / read mail | `search_messages`, `read_message` | `aiconnect messages search ...`, `messages read <id>` |
| act on mail | `move_messages`, `update_messages`, `delete_messages` | `messages move/mark/delete` |

## The organizing workflow (follow this order)

1. `status`. If it fails: Thunderbird must be running with the AIConnect extension installed, and the
   extension's port/token must match `aiconnect pair`. Tell the user exactly that; do not retry blindly.
2. `scan` all accounts (or the one the user named). Note per account: inbox size, unread, per-year
   spread, recent top senders, and the existing folder layout. Some IMAP servers nest every folder under
   `Inbox/` (Dovecot/Plesk); always use the paths the scan returns.
3. `suggest`. It reuses existing folders by synonym (Boekhouding = Receipts, Nieuwsbrieven = Newsletters),
   proposes vendor sub-folders only for high-volume senders, and never proposes deleting anything.
   Read it critically: the heuristics are good on automated mail and weak on humans. Fix obvious
   misfiles (a client's invoices are not "newsletters"), merge near-duplicate folders, keep names in the
   language the user's existing folders use.
4. Show the user the plan with counts before moving anything: folders to create, rules with match
   counts, the archive step, and the unsubscribe list. Ask what to change.
5. `rules_dry_run` with the final rules. Compare against the plan; surprises mean a pattern is too broad
   (a bare domain like `google.com` catches everything from Google). Narrow with full addresses.
6. After approval: `rules_apply`, then `rules_save` so new mail keeps sorting, then `archive` (dry run
   first, then confirm). Report what moved, per account.
7. Hand the unsubscribe candidates to the user. Do not click unsubscribe links yourself.

## Rules format

```json
[{"account":"me@example.com","field":"from","patterns":["medium.com","@substack.com"],"dest":"Inbox/News/Reading","note":"why"}]
```

`field`: `from` (author string), `subject`, `any` (both) or `to`. Patterns are case-insensitive
substrings; any match. First matching rule wins, so order specific rules before generic ones.
`dest` is a folder path by names in the same account; missing folders are created. Rules only ever act
on that account's inbox (or `sourceFolder` when given).

## Safety rules

- Moves are reversible; deletes are not. Never call `delete_messages` (or `messages delete`) without a
  direct instruction naming what to delete. Prefer moving to a `Trash` or `Spam` folder via a rule.
- Archive defaults skip unread and flagged mail. Keep it that way unless asked.
- Gmail: "archive" means moving out of Inbox into `[Gmail]/All Mail`. Do not create year folders there.
- Large moves (tens of thousands) take minutes over IMAP; that is normal. Do not re-run while one is in flight.
- Do not fetch message bodies in bulk. `read_message` is for individual messages the user asks about.

## Typical questions and how to answer them

- "Who mails me most?" → `scan` (recentSenders) for the account; answer with counts and the window.
- "Find the invoice from X" → `search_messages` with `author` and maybe `subject`, then `read_message`.
- "Set up filters for newsletters" → scan → suggest (only the newsletters part) → dry-run → apply → save.
- "Clean up my inbox" → the full workflow above.

## Install / pairing (if the user has not done it)

Not on npm yet — install from the repo (github.com/guuslangelaar0/aiconnect):
```
git clone https://github.com/guuslangelaar0/aiconnect.git && cd aiconnect && npm install && npm link
aiconnect pair                # prints port + token, writes ~/.aiconnect/config.json
aiconnect build-xpi           # dist/aiconnect-<version>.xpi (or grab it from Releases)
```
Without `npm link`, run `node dist/aiconnect.mjs <cmd>` instead of `aiconnect <cmd>`.
Thunderbird: Add-ons and Themes → gear → Install Add-on From File → the .xpi. Open the AIConnect
options (toolbar button), paste port + token, Save. `aiconnect status` should now say connected.
For MCP: `{"mcpServers":{"aiconnect":{"command":"aiconnect","args":["mcp"]}}}`.
