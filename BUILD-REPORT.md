# BUILD REPORT — rolesignal

Clean-room rebuild of `com.lastminutedealshq/company-signals` v1.1.1
(remote-only MCP server at
`https://company-signals.lastminutedealshq.com/mcp`), built 2026-10-28
as a forwarding client. Package: `@reneturcios/rolesignal` 0.1.0,
registry name `io.github.CloudCorpRecords/rolesignal`.

## Surface built

Labelled subset: **4 of the 5 captured tools built**, 1 omitted.

| Tool | Required fields as served |
|------|---------------------------|
| `lookup_company_free` | `host` |
| `get_company_open_roles` | `host` |
| `get_hiring_changes` | `day` |
| `coverage` | *(no `required` key in schema)* |

Every tool object carries exactly the fixture's keys — `name`,
`description`, `inputSchema` — in order. The capture carries no
`title` key and none was invented. Tool literals were generated
programmatically from
`harness/fixtures/companysignals-tools-original.json` by the script
at `/tmp/b41-rolesignal-gen.py` (parse + re-serialise of the fixture
JSON into `src/forward.ts`) — never retyped — and a post-generation
check (the registration-integrity test suite, plus the parity
harness) confirmed the served literals deep-equal the fixture's
4 tool objects in order. Tools are registered via the MCP SDK
low-level Server API (`ListToolsRequestSchema` /
`CallToolRequestSchema` handlers), not McpServer+zod.

## Omission and absence assertions

- **Omitted:** `request_api_key` (required: `email`). Its captured
  description says it emails a free API key link to the user's
  address — minting an API key from a caller-supplied email address
  (the ismynumberspam family) — so it is omitted entirely, per the
  spec.
- **Absence asserted in tests at three levels:**
  - *Registry level:* `request_api_key` is not in `TOOL_NAMES` or
    `TOOL_DEFS` (`TOOL_DEFS.length == 4`), and `isKnownTool` rejects
    it.
  - *MCP layer:* `handleCallTool` rejects `request_api_key` with
    `McpError` `MethodNotFound`, before any network hop (stubbed
    upstream recorded 0 calls).
  - *CLI level:* `rolesignal request_api_key '{"email":"a@example.com"}'`
    prints Usage on stderr and exits 2, and the usage text does not
    list `request_api_key`.

## Labelled reconstructions (from the spec's Wire section)

- Upstream endpoint pinned:
  `https://company-signals.lastminutedealshq.com/mcp`.
- Env override `COMPANYSIGNALS_MCP_URL` — labelled reconstruction.
- Key forwarding: the registry record pins a secret `x-api-key`
  header. When `COMPANYSIGNALS_API_KEY` is set, header
  `x-api-key: <value>` is sent on every upstream request (header
  name pinned by the record; env forwarding is a labelled
  reconstruction — the capture was keyless). When unset or blank,
  no key header is sent. Both branches are tested, and tests also
  assert no `Authorization` header is ever sent.
- Error rendering `rolesignal error:` text for upstream failures —
  labelled reconstruction.
- Upstream results pass through verbatim, including `isError` and
  extra fields. tools/call is forwarded as streamable-HTTP JSON-RPC:
  initialize (protocolVersion `2025-03-26`) →
  notifications/initialized → tools/call, honouring
  `Mcp-Session-Id` when issued; plain-JSON and SSE replies are both
  parsed. The forwarding core takes an injectable fetch; tests stub
  the upstream — no live network calls in tests.

## Fixture conflicts

**None.** The spec and the fixture agree on tool names, order,
required fields (present on exactly the three tools listed above,
absent on `coverage`), descriptions, and the absence of any `title`
key.

## Deviations

None.

## Lockfile

- Route: **Route 3** — generated clean from birth in the build dir
  with no `node_modules` and no pre-existing lockfile:
  `npm install --package-lock-only --ignore-scripts --offline`.
- Parses as JSON; `name` == `@reneturcios/rolesignal`.
- Package entries: **128**.
- sha256: `c92c1bcd67c64313764f71423dc4b6977f1b809464e61f6b3c42f0befb5101e3`
  (re-verified unchanged after the subsequent offline `npm install`).

## server.json

- Description exactly: "Company hiring signals: open-role counts,
  daily role history and day-by-day hiring changes." — **91
  characters**.
- npm package entry carries `"version": "0.1.0"`; the OCI entry
  (`ghcr.io/cloudcorprecords/rolesignal:0.1.0`) carries **no**
  `version` field. Dockerfile (node:20-alpine, both stages) carries
  the label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/rolesignal"`.
  Container workflow `IMAGE` is `ghcr.io/cloudcorprecords/rolesignal`
  and its smoke test asserts the server name `rolesignal`.

## Verification (all run 2026-10-28, foreground, read from disk)

1. `npx tsc --noEmit` → exit 0.
2. `npm run build` → exit 0; real `dist/` produced (cli, forward,
   index, mcp, types — .js, .d.ts, .js.map each).
3. `node dist/cli.js --version` → `0.1.0`; unknown subcommand →
   Usage on stderr, exit 2.
4. `npm test` → **60 tests, 60 pass, 0 fail** (registration-integrity
   suite deep-equals the served tools/list against the fixture's 4
   tools in order; absence assertions for `request_api_key` at the
   registry, MCP-layer and CLI levels; session handling/reuse, env
   override, `x-api-key` present/absent/blank branches, verbatim
   argument forwarding and result pass-through including upstream
   isError, SSE parsing, error rendering, MCP-layer validation, and
   CLI behaviour).
5. Parity: `python3 harness/parity.py --original
   harness/fixtures/companysignals-tools-original.json --rebuild
   "stdio:node /home/hatch/workspace/mcp-rebuild-100/builds/rolesignal/dist/cli.js mcp"
   --out builds/rolesignal/parity-out` → **verdict PASS, parity
   100.0** (4/4 identical, 0 missing, 0 extra, no schema diffs).
   Output in `parity-out/`.
