# Changelog

## 0.2.2
- Resumable, bounded rule application: `rules.run` remembers a scan cursor between calls
  and caps moves per call, so sorting completes on very large (25k+) inboxes even when the
  IMAP server throttles and the host limits each call's duration.

## 0.2.1
- Per-call move cap on `rules.run` / `archive.run` with `done`/`remaining` reporting.

## 0.2.0
- Automatic port fallback: the extension, CLI and MCP server walk a predefined port list
  (47800-47804) and converge on the first free port or existing hub.
- Bridge hub/peer model: multiple CLI/MCP processes share one Thunderbird connection
  instead of fighting over the port.

## 0.1.0
- Initial release: Thunderbird extension + Node CLI + MCP server over a local, token-paired
  WebSocket. Inventory, sender/domain/year analysis, folder creation, sorting rules
  (dry-run / apply / save ongoing), and archiving.
