# Changelog

## 0.1.0 (2026-10-28)

- First release: a forwarding client for the hosted Company Signals MCP server. The four built tools are answered locally for tools/list, and every tools/call is forwarded upstream over a streamable-HTTP JSON-RPC session (initialize, notifications/initialized, tools/call, honouring the Mcp-Session-Id header when the upstream issues one).
- Tools: `lookup_company_free`, `get_company_open_roles`, `get_hiring_changes` and `coverage`. The surface reads public careers-board data compiled by the vendor: open-role counts, daily role history and day-by-day hiring changes.
- Labelled subset: the captured `request_api_key` tool is omitted — it emails an API-key link to a caller-supplied email address (key minting from email) — and its absence is asserted in tests at the registry, MCP-layer and CLI levels.
- Upstream results pass through verbatim, including the isError flag; upstream failures surface as `rolesignal error:` text results.
- One bin serves the CLI (one subcommand per tool, plus `--version`) and the stdio MCP server (`mcp` subcommand). The upstream endpoint can be overridden via `COMPANYSIGNALS_MCP_URL`; when `COMPANYSIGNALS_API_KEY` is set it is sent as an `x-api-key` header on every upstream request.
