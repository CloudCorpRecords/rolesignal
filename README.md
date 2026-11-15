# rolesignal

Hiring changes leave a public trace on careers boards long before they are announced. rolesignal is a small local bridge to the hosted Company Signals MCP service: you can check how many open jobs a company has today, read its daily open-role history by department, see which companies changed their hiring on a given day, and check how much of the market the service covers.

Nothing is stored or computed on your own machine. This package answers `tools/list` locally from the captured tool definitions and forwards every `tools/call` to the hosted service over a streamable-HTTP JSON-RPC session, returning whatever the service sends back unchanged.

The data is compiled by the vendor from public careers boards and is not human-reviewed; the vendor notes removal is available on request.

## The tools

This is a labelled subset: 4 of the 5 captured tools are built. The captured `request_api_key` tool is omitted — it emails an API-key link to a caller-supplied email address, which is key minting from email — and its absence is asserted in the test suite at the registry, MCP-layer and CLI levels.

- **`lookup_company_free`** — The free sample for one company, addressed by its website domain (`host`, no www): whether the company is tracked, today's open-role count and, once the series is long enough, the 7-day change. No API key is needed for this tool upstream; it is limited to 10 calls a day per caller.
- **`get_company_open_roles`** — Daily history for one company (`host`): the open-role count per day and per department, and the careers board it comes from. The upstream service says this tool needs a free API key (300 calls a day).
- **`get_hiring_changes`** — Which companies changed their number of open jobs on a given day (`day`, YYYY-MM-DD in UTC; the series starts 2026-10-09), largest change first. The optional `min_delta` sets the smallest change to include (default 1). The upstream service says this tool needs a free API key (300 calls a day).
- **`coverage`** — How many companies and careers boards are tracked and how many days have been captured. No key needed, and it takes no arguments.

## Install and run

As an MCP server via npm:

```bash
npx -y @reneturcios/rolesignal mcp
```

MCP client configuration:

```json
{
  "mcpServers": {
    "rolesignal": {
      "command": "npx",
      "args": ["-y", "@reneturcios/rolesignal", "mcp"]
    }
  }
}
```

As a container:

```bash
docker run -i ghcr.io/cloudcorprecords/rolesignal
docker run --rm ghcr.io/cloudcorprecords/rolesignal coverage '{}'
```

## CLI

One binary serves both the command line and the MCP server. Each tool is a subcommand taking a single JSON string with that tool's arguments:

```bash
rolesignal lookup_company_free '{"host":"example-co.test"}'
rolesignal get_company_open_roles '{"host":"example-co.test"}'
rolesignal get_hiring_changes '{"day":"2026-10-20","min_delta":2}'
rolesignal coverage '{}'
rolesignal --version
```

Exit codes: `0` when the forwarded call succeeds, `1` when the upstream result is an error, and `2` for usage problems such as an unknown subcommand or a malformed JSON argument.

## Configuration

- `COMPANYSIGNALS_MCP_URL` — Overrides the upstream endpoint. The default is the pinned hosted endpoint, `https://company-signals.lastminutedealshq.com/mcp`. (The override variable is a reconstruction added by this rebuild.)
- `COMPANYSIGNALS_API_KEY` — When set, its value is sent to the upstream on every request as an `x-api-key: <value>` header. When it is not set, no key header is sent at all, matching the keyless behaviour the tool surface was captured with. (The hosted service's registry record pins the secret `x-api-key` header name; the environment-variable forwarding is a reconstruction added by this rebuild.)

Upstream failures — a JSON-RPC error from the service, a non-2xx response, an unreadable body, or a request that fails outright — are reported to the caller as an error result whose text starts with `rolesignal error:`.

## How forwarding works

The first forwarded call opens a session: an `initialize` request (protocol version `2025-03-26`), followed by a `notifications/initialized` notification, then the `tools/call` itself. If the service answers the initialize request with an `Mcp-Session-Id` header, that value is carried on every later request, and the open session is reused for the rest of the process. Replies are accepted either as plain JSON or as server-sent events. Successful results pass through verbatim, including any `isError` flag and any extra fields the service includes.

## Development

```bash
npm install
npm run build   # tsc -> dist/ (dist/cli.js is the bin)
npm test        # tsx --test test/*.test.ts — stubbed upstream, no network
npm run dev     # run the CLI from source
```

The test suite checks the served tool list against the captured surface tool by tool, asserts the omitted `request_api_key` tool is absent at the registry, MCP-layer and CLI levels, exercises the session handshake and its reuse, covers both key-header branches, and verifies that arguments go upstream untouched and results come back untouched.

## License

MIT — see `LICENSE`. Copyright (c) 2026 Rene Turcios.
