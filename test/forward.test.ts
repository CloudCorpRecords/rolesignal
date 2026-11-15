import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  RolesignalClient,
  callTool,
  createClient,
  DEFAULT_ENDPOINT_URL,
  isKnownTool,
  parseRpcBody,
  PROTOCOL_VERSION,
  TOOL_DEFS,
  TOOL_NAMES,
  VERSION,
} from "../src/forward.js";
import { handleCallTool } from "../src/mcp.js";
import type {
  FetchFn,
  FetchResponseLike,
  ToolDef,
  ToolResult,
} from "../src/types.js";

/**
 * Every test runs against a stubbed JSON-RPC upstream that
 * implements the streamable-HTTP session flow
 * (initialize -> notifications/initialized -> tools/call):
 * no live network, and the real Company Signals endpoint is
 * never contacted.
 */

const FIXTURE_URL = new URL(
  "../../../harness/fixtures/companysignals-tools-original.json",
  import.meta.url,
);
const FIXTURE_AVAILABLE = existsSync(FIXTURE_URL);
const fixture = (
  FIXTURE_AVAILABLE
    ? JSON.parse(readFileSync(FIXTURE_URL, "utf-8"))
    : { tools: [] }
) as {
  tools: ToolDef[];
};
/**
 * Publish-survival guard (Wave 25 preflight, proven Wave 24 pattern):
 * the parity fixture lives in the build harness, outside the published
 * repo tree, so fixture-dependent tests skip cleanly when it is absent;
 * with the fixture present they run in full, with no skips.
 */
function skipWithoutFixture(t: {
  skip: (message: string) => void;
}): boolean {
  if (FIXTURE_AVAILABLE) return false;
  t.skip("parity fixture lives in the build harness, not the repo tree");
  return true;
}


const LOOKUP = "lookup_company_free";
const ROLES = "get_company_open_roles";
const CHANGES = "get_hiring_changes";
const COVERAGE = "coverage";
const ALL_TOOLS = [LOOKUP, ROLES, CHANGES, COVERAGE];
const OMITTED_TOOLS = ["request_api_key"];
const OMITTED = "request_api_key";

const SAMPLE_RESULT = {
  content: [{ type: "text", text: "{\"host\":\"example-co.test\",\"open_roles\":12}" }],
  structuredContent: { host: "example-co.test", open_roles: 12 },
};

interface Captured {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

interface FakeOptions {
  callResult?: Record<string, unknown>;
  callBodyText?: string;
  callError?: Record<string, unknown>;
  callStatus?: number;
  initError?: Record<string, unknown>;
  throwOn?: "initialize" | "tools/call";
  sessionId?: string | null;
  hangOnCall?: boolean;
  sse?: boolean;
}

function makeResponse(
  status: number,
  bodyText: string,
  headers: Record<string, string> = {},
): FetchResponseLike {
  const lowered = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name: string) => lowered.get(name.toLowerCase()) ?? null },
    text: async () => bodyText,
  };
}

function jsonResponse(
  status: number,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return makeResponse(status, JSON.stringify(payload), headers);
}

function makeUpstream(options: FakeOptions = {}): {
  fetchFn: FetchFn;
  calls: Captured[];
} {
  const calls: Captured[] = [];
  const fetchFn: FetchFn = async (url, init) => {
    const body = JSON.parse(init?.body ?? "{}") as Record<string, unknown>;
    calls.push({ url, headers: init?.headers ?? {}, body });
    const method = body.method as string;
    if (options.throwOn === method) throw new Error("socket hang up");
    if (method === "initialize") {
      if (options.initError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.initError,
        });
      }
      const headers: Record<string, string> = {};
      const sessionId =
        options.sessionId === undefined ? "sess-xyz" : options.sessionId;
      if (sessionId !== null) headers["mcp-session-id"] = sessionId;
      return jsonResponse(
        200,
        {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            serverInfo: { name: "company-signals", version: "1.1.1" },
          },
        },
        headers,
      );
    }
    if (method === "notifications/initialized") {
      return makeResponse(202, "");
    }
    if (method === "tools/call") {
      if (options.hangOnCall) {
        return new Promise<FetchResponseLike>((_resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            if (signal.aborted) {
              reject(new Error("aborted"));
              return;
            }
            signal.addEventListener("abort", () => reject(new Error("aborted")));
          }
        });
      }
      if (options.callBodyText !== undefined) {
        return makeResponse(options.callStatus ?? 200, options.callBodyText);
      }
      if (options.callError !== undefined) {
        return jsonResponse(200, {
          jsonrpc: "2.0",
          id: body.id,
          error: options.callError,
        });
      }
      const result = options.callResult ?? SAMPLE_RESULT;
      const payload = { jsonrpc: "2.0", id: body.id, result };
      if (options.sse) {
        return makeResponse(
          200,
          `event: message\ndata: ${JSON.stringify(payload)}\n\n`,
        );
      }
      return jsonResponse(options.callStatus ?? 200, payload);
    }
    return jsonResponse(200, {});
  };
  return { fetchFn, calls };
}

function stubClient(options: FakeOptions = {}, extra: Record<string, unknown> = {}) {
  const upstream = makeUpstream(options);
  const c = new RolesignalClient({
    fetchFn: upstream.fetchFn,
    env: {},
    ...extra,
  });
  return { client: c, calls: upstream.calls };
}

function textOf(result: ToolResult): string {
  const content = result.content as Array<{ type: string; text: string }>;
  return content[0].text;
}

function methods(calls: Captured[]): string[] {
  return calls.map((c) => c.body.method as string);
}

function schemaOf(tool: ToolDef): Record<string, any> {
  return tool.inputSchema as Record<string, any>;
}

/* ------------------------------------------------------------------ */

describe("registration integrity (captured surface)", () => {
  it("serves exactly the fixture's 4 tools, deep-equal, in order", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.length, 4);
    assert.deepEqual(TOOL_DEFS, fixture.tools);
  });

  it("serves the 4 tool names in fixture order", () => {
    assert.deepEqual(TOOL_NAMES, ALL_TOOLS);
  });

  it("carries exactly the fixture's keys on each tool (no title invented)", () => {
    for (const tool of TOOL_DEFS) {
      assert.deepEqual(Object.keys(tool).sort(), [
        "description",
        "inputSchema",
        "name",
      ]);
      assert.equal("title" in tool, false);
    }
  });

  it("carries no required key on coverage", () => {
    assert.equal("required" in schemaOf(TOOL_DEFS[3]), false);
    assert.equal(schemaOf(TOOL_DEFS[3]).required, undefined);
  });

  it("requires exactly the fixture's fields on the other three tools", () => {
    assert.deepEqual(schemaOf(TOOL_DEFS[0]).required, ["host"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[1]).required, ["host"]);
    assert.deepEqual(schemaOf(TOOL_DEFS[2]).required, ["day"]);
  });

  it("carries object type on every inputSchema and no $schema marker", () => {
    for (const tool of TOOL_DEFS) {
      assert.equal(schemaOf(tool).type, "object");
      assert.equal("$schema" in schemaOf(tool), false);
    }
  });

  it("carries every fixture property, in order, for all four tools", (t) => {
    if (skipWithoutFixture(t)) return;
    for (let i = 0; i < 4; i += 1) {
      const served = Object.keys(schemaOf(TOOL_DEFS[i]).properties);
      const expected = Object.keys(schemaOf(fixture.tools[i]).properties);
      assert.deepEqual(served, expected);
    }
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[0]).properties), ["host"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[1]).properties), ["host"]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[2]).properties), [
      "day",
      "min_delta",
    ]);
    assert.deepEqual(Object.keys(schemaOf(TOOL_DEFS[3]).properties), []);
  });

  it("carries lookup_company_free's host shape verbatim", () => {
    const props = schemaOf(TOOL_DEFS[0]).properties;
    assert.equal(props.host.type, "string");
    assert.match(props.host.description, /example-co\.test/);
  });

  it("carries get_hiring_changes' argument shapes verbatim", () => {
    const props = schemaOf(TOOL_DEFS[2]).properties;
    assert.equal(props.day.type, "string");
    assert.match(props.day.description, /YYYY-MM-DD/);
    assert.match(props.day.description, /2026-10-09/);
    assert.equal(props.min_delta.type, "integer");
    assert.match(props.min_delta.description, /default 1/);
  });

  it("isKnownTool recognises the 4 built tools and rejects others", () => {
    for (const name of ALL_TOOLS) assert.equal(isKnownTool(name), true);
    assert.equal(isKnownTool("lookup_company"), false);
    assert.equal(isKnownTool("get_company"), false);
    assert.equal(isKnownTool(""), false);
  });
});

/* ------------------------------------------------------------------ */

describe("labelled omission: request_api_key is absent", () => {
  it("the omitted tool is not among the served tool names (registry level)", () => {
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(TOOL_NAMES.includes(omitted), false);
      assert.equal(TOOL_DEFS.some((t) => t.name === omitted), false);
    }
    assert.equal(TOOL_DEFS.length, 4);
  });

  it("isKnownTool rejects the omitted tool (registry level)", () => {
    for (const omitted of OMITTED_TOOLS) {
      assert.equal(isKnownTool(omitted), false);
    }
  });

  it("the fixture itself carries no request_api_key tool", (t) => {
    if (skipWithoutFixture(t)) return;
    assert.equal(fixture.tools.some((t) => t.name === OMITTED), false);
  });

  it("the MCP layer rejects request_api_key as unknown, before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "request_api_key", { email: "a@example.com" }),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });
});

/* ------------------------------------------------------------------ */

describe("session establishment and reuse", () => {
  it("runs initialize, notifications/initialized, then tools/call in order", async () => {
    const { client: c, calls } = stubClient();
    const out = await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.equal(out.isError, undefined);
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
    ]);
    assert.ok(calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
    assert.equal(
      DEFAULT_ENDPOINT_URL,
      "https://company-signals.lastminutedealshq.com/mcp",
    );
    for (const call of calls) {
      assert.equal(call.headers["Content-Type"], "application/json");
      assert.equal(call.headers["Accept"], "application/json, text/event-stream");
    }
    assert.equal(calls[0].headers["Mcp-Session-Id"], undefined);
    assert.equal(calls[1].headers["Mcp-Session-Id"], "sess-xyz");
    assert.equal(calls[2].headers["Mcp-Session-Id"], "sess-xyz");
  });

  it("sends clientInfo name rolesignal and the pinned protocol version on initialize", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(COVERAGE, {});
    const initParams = calls[0].body.params as Record<string, unknown>;
    assert.equal(initParams.protocolVersion, PROTOCOL_VERSION);
    assert.equal(PROTOCOL_VERSION, "2025-03-26");
    assert.deepEqual(initParams.capabilities, {});
    assert.deepEqual(initParams.clientInfo, { name: "rolesignal", version: VERSION });
  });

  it("establishes the session lazily once and reuses it on later calls", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(COVERAGE, {});
    await c.callTool(ROLES, { host: "example-co.test" });
    assert.deepEqual(methods(calls), [
      "initialize",
      "notifications/initialized",
      "tools/call",
      "tools/call",
    ]);
    assert.equal(calls[3].headers["Mcp-Session-Id"], "sess-xyz");
    assert.notEqual(calls[2].body.id, calls[3].body.id);
  });

  it("sends no session header when the upstream issues none", async () => {
    const { client: c, calls } = stubClient({ sessionId: null });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, undefined);
    assert.ok(calls.every((call) => call.headers["Mcp-Session-Id"] === undefined));
  });

  it("honours the COMPANYSIGNALS_MCP_URL env override", async () => {
    const upstream = makeUpstream();
    const c = new RolesignalClient({
      fetchFn: upstream.fetchFn,
      env: { COMPANYSIGNALS_MCP_URL: "https://staging.example.com/mcp" },
    });
    await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.ok(
      upstream.calls.every((call) => call.url === "https://staging.example.com/mcp"),
    );
  });

  it("honours an explicit url override over the default endpoint", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: {},
      url: "https://alt.example.com/mcp",
    });
    await c.callTool(CHANGES, { day: "2026-10-20" });
    assert.ok(upstream.calls.every((call) => call.url === "https://alt.example.com/mcp"));
  });

  it("prefers an explicit url override over the env override", async () => {
    const upstream = makeUpstream();
    const c = createClient({
      fetchFn: upstream.fetchFn,
      env: { COMPANYSIGNALS_MCP_URL: "https://env.example.com/mcp" },
      url: "https://explicit.example.com/mcp",
    });
    await c.callTool(COVERAGE, {});
    assert.ok(
      upstream.calls.every((call) => call.url === "https://explicit.example.com/mcp"),
    );
  });

  it("falls back to the pinned endpoint when the env override is blank", async () => {
    const upstream = makeUpstream();
    const c = new RolesignalClient({
      fetchFn: upstream.fetchFn,
      env: { COMPANYSIGNALS_MCP_URL: "   " },
    });
    await c.callTool(COVERAGE, {});
    assert.ok(upstream.calls.every((call) => call.url === DEFAULT_ENDPOINT_URL));
  });
});

/* ------------------------------------------------------------------ */

describe("upstream key header", () => {
  it("sends x-api-key on every request when COMPANYSIGNALS_API_KEY is set", async () => {
    const upstream = makeUpstream();
    const c = new RolesignalClient({
      fetchFn: upstream.fetchFn,
      env: { COMPANYSIGNALS_API_KEY: "cs-key-42" },
    });
    await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.equal(upstream.calls.length, 3);
    assert.ok(
      upstream.calls.every((call) => call.headers["x-api-key"] === "cs-key-42"),
    );
  });

  it("sends no x-api-key header when COMPANYSIGNALS_API_KEY is unset", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.ok(calls.every((call) => call.headers["x-api-key"] === undefined));
  });

  it("sends no x-api-key header when COMPANYSIGNALS_API_KEY is blank", async () => {
    const upstream = makeUpstream();
    const c = new RolesignalClient({
      fetchFn: upstream.fetchFn,
      env: { COMPANYSIGNALS_API_KEY: "   " },
    });
    await c.callTool(COVERAGE, {});
    assert.ok(
      upstream.calls.every((call) => call.headers["x-api-key"] === undefined),
    );
  });

  it("never sends an Authorization header, with or without a key", async () => {
    const withKey = makeUpstream();
    const c1 = new RolesignalClient({
      fetchFn: withKey.fetchFn,
      env: { COMPANYSIGNALS_API_KEY: "cs-key-42" },
    });
    await c1.callTool(COVERAGE, {});
    assert.ok(withKey.calls.every((call) => call.headers["Authorization"] === undefined));
    const { client: c2, calls } = stubClient();
    await c2.callTool(COVERAGE, {});
    assert.ok(calls.every((call) => call.headers["Authorization"] === undefined));
  });
});

/* ------------------------------------------------------------------ */

describe("tools/call forwarding", () => {
  it("forwards a lookup_company_free call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { host: "example-co.test" };
    await c.callTool(LOOKUP, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, LOOKUP);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_company_open_roles call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { host: "example-co.test" };
    await c.callTool(ROLES, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, ROLES);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a get_hiring_changes call verbatim", async () => {
    const { client: c, calls } = stubClient();
    const args = { day: "2026-10-20", min_delta: 3 };
    await c.callTool(CHANGES, args);
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHANGES);
    assert.deepEqual(params.arguments, args);
  });

  it("forwards a coverage call verbatim", async () => {
    const { client: c, calls } = stubClient();
    await c.callTool(COVERAGE, {});
    const params = calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, COVERAGE);
    assert.deepEqual(params.arguments, {});
  });

  it("passes the upstream result through verbatim, including extra fields", async () => {
    const { client: c } = stubClient();
    const out = await c.callTool(ROLES, { host: "example-co.test" });
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("passes an upstream isError result through untouched", async () => {
    const upstreamResult = {
      content: [{ type: "text", text: "no such company" }],
      isError: true,
    };
    const { client: c } = stubClient({ callResult: upstreamResult });
    const out = await c.callTool(ROLES, { host: "nope.test" });
    assert.deepEqual(out, upstreamResult);
  });

  it("reads an SSE-framed tools/call response", async () => {
    const { client: c } = stubClient({ sse: true });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
  });

  it("the one-shot callTool helper forwards under the right tool name", async () => {
    const upstream = makeUpstream();
    const out = await callTool(
      CHANGES,
      { day: "2026-10-20" },
      { fetchFn: upstream.fetchFn, env: {} },
    );
    assert.equal(out.isError, undefined);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHANGES);
    assert.deepEqual(params.arguments, { day: "2026-10-20" });
  });
});

/* ------------------------------------------------------------------ */

describe("upstream failures surface as rolesignal error text", () => {
  it("maps a JSON-RPC error to `rolesignal error: <message>`", async () => {
    const { client: c } = stubClient({
      callError: { code: -32000, message: "lookup failed upstream" },
    });
    const out = await c.callTool(ROLES, { host: "example-co.test" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: lookup failed upstream");
  });

  it("maps an initialize JSON-RPC error to rolesignal error text", async () => {
    const { client: c } = stubClient({
      initError: { code: -32600, message: "bad initialize" },
    });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: bad initialize");
  });

  it("maps an unparseable upstream response to a malformed-response error", async () => {
    const { client: c } = stubClient({ callBodyText: "<html>oops</html>" });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: malformed response");
  });

  it("maps a response with no result object to a malformed-response error", async () => {
    const { client: c } = stubClient({
      callBodyText: '{"jsonrpc":"2.0","id":3,"result":null}',
    });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: malformed response");
  });

  it("maps a non-2xx upstream status to rolesignal error text", async () => {
    const { client: c } = stubClient({ callBodyText: "internal error", callStatus: 500 });
    const out = await c.callTool(COVERAGE, {});
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: HTTP 500");
  });

  it("maps a throwing fetch to rolesignal error text", async () => {
    const { client: c } = stubClient({ throwOn: "tools/call" });
    const out = await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rolesignal error: /);
  });

  it("maps a throwing initialize fetch to rolesignal error text", async () => {
    const { client: c } = stubClient({ throwOn: "initialize" });
    const out = await c.callTool(LOOKUP, { host: "example-co.test" });
    assert.equal(out.isError, true);
    assert.equal(textOf(out), "rolesignal error: socket hang up");
  });

  it("maps a timed-out call to rolesignal error text", async () => {
    const { client: c } = stubClient({ hangOnCall: true }, { timeoutMs: 20 });
    const out = await c.callTool(ROLES, { host: "example-co.test" });
    assert.equal(out.isError, true);
    assert.match(textOf(out), /^rolesignal error: /);
  });
});

/* ------------------------------------------------------------------ */

describe("parseRpcBody", () => {
  it("parses plain JSON and picks the message with the matching id", () => {
    const body = '{"jsonrpc":"2.0","id":7,"result":{"ok":true}}';
    assert.deepEqual(parseRpcBody(body, 7), {
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
  });

  it("parses SSE data lines", () => {
    const body =
      'event: message\ndata: {"jsonrpc":"2.0","id":2,"result":{"ok":true}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { ok: true },
    });
  });

  it("picks the matching id among several SSE messages", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":1,"result":{"n":1}}\n\n' +
      'data: {"jsonrpc":"2.0","id":2,"result":{"n":2}}\n\n';
    assert.deepEqual(parseRpcBody(body, 2), {
      jsonrpc: "2.0",
      id: 2,
      result: { n: 2 },
    });
  });

  it("ignores the SSE [DONE] sentinel", () => {
    const body =
      'data: {"jsonrpc":"2.0","id":4,"result":{"ok":true}}\ndata: [DONE]\n';
    assert.deepEqual(parseRpcBody(body, 4), {
      jsonrpc: "2.0",
      id: 4,
      result: { ok: true },
    });
  });

  it("returns null for empty and unparseable bodies", () => {
    assert.equal(parseRpcBody(""), null);
    assert.equal(parseRpcBody("not json at all"), null);
    assert.equal(parseRpcBody("[1,2,3]"), null);
  });
});

/* ------------------------------------------------------------------ */

describe("MCP layer validation", () => {
  it("rejects an unknown tool with MethodNotFound before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, "not_a_tool", {}),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.MethodNotFound,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects array arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, LOOKUP, ["nope"]),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("rejects string arguments with InvalidParams before any network hop", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    await assert.rejects(
      () => handleCallTool(c, ROLES, "host=example-co.test"),
      (err: unknown) =>
        err instanceof McpError && err.code === ErrorCode.InvalidParams,
    );
    assert.equal(upstream.calls.length, 0);
  });

  it("forwards a valid lookup_company_free call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, LOOKUP, { host: "example-co.test" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, { host: "example-co.test" });
  });

  it("forwards a valid get_hiring_changes call through the MCP layer unchanged", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, CHANGES, { day: "2026-10-20" });
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.equal(params.name, CHANGES);
  });

  it("treats omitted arguments as an empty object", async () => {
    const upstream = makeUpstream();
    const c = createClient({ fetchFn: upstream.fetchFn, env: {} });
    const out = await handleCallTool(c, COVERAGE, undefined);
    assert.deepEqual(out, SAMPLE_RESULT);
    const params = upstream.calls[2].body.params as Record<string, unknown>;
    assert.deepEqual(params.arguments, {});
  });
});

/* ------------------------------------------------------------------ */

describe("CLI", () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

  function runCli(args: string[]) {
    return spawnSync(process.execPath, ["--import", "tsx", cliPath, ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 30000,
    });
  }

  it("--version prints 0.1.0 and exits 0", () => {
    const res = runCli(["--version"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
    assert.equal(res.stdout.trim(), VERSION);
  });

  it("-v prints 0.1.0 and exits 0", () => {
    const res = runCli(["-v"]);
    assert.equal(res.status, 0);
    assert.equal(res.stdout.trim(), "0.1.0");
  });

  it("an unknown command prints usage on stderr and exits 2", () => {
    const res = runCli(["not-a-tool"]);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
  });

  it("the omitted request_api_key tool is not a CLI command and exits 2 (CLI level)", () => {
    const res = runCli(["request_api_key", '{"email":"a@example.com"}']);
    assert.equal(res.status, 2);
    assert.match(res.stderr, /Usage:/);
    assert.equal(res.stderr.includes("request_api_key"), false);
  });

  it("a non-JSON argument exits 2", () => {
    const res = runCli([LOOKUP, "not json"]);
    assert.equal(res.status, 2);
  });

  it("a JSON array argument exits 2", () => {
    const res = runCli([LOOKUP, "[]"]);
    assert.equal(res.status, 2);
  });

  it("extra arguments after mcp exit 2", () => {
    const res = runCli(["mcp", "extra"]);
    assert.equal(res.status, 2);
  });
});
