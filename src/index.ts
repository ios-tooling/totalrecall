// Total Recall: shared work history and memory for coding agents.
//   POST /mcp        MCP over Streamable HTTP (AGENT_TOKEN)
//   POST /v1/events  hook events from Claude Code and Codex (INGEST_TOKEN or AGENT_TOKEN)
//   GET  /           health
// Secrets: AGENT_TOKEN, INGEST_TOKEN, COS_INGEST_TOKEN. Never log them.

import { createMcpHandler } from "@modelcontextprotocol/server";
import { createServer } from "./mcp";
import { handleHookEvent, parseHookRequest } from "./turns";
import { type AppEnv, UserError, hasBearer, json } from "./util";

const unauthorized = () =>
  new Response(JSON.stringify({ error: "Unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json", "www-authenticate": 'Bearer realm="totalrecall"' },
  });

async function route(request: Request, env: AppEnv, ctx: ExecutionContext): Promise<Response> {
  const { pathname } = new URL(request.url);

  if (pathname === "/" && request.method === "GET") return json(200, { name: "totalrecall", version: "0.1.0" });

  if (pathname === "/mcp") {
    if (!hasBearer(request, env.AGENT_TOKEN)) return unauthorized();
    // Clients that cannot say where they run (no hooks) may name it in a header.
    const machine = request.headers.get("x-totalrecall-machine")?.trim().slice(0, 100) || null;
    // Stateless: every request gets a fresh server, so nothing is shared between callers.
    return createMcpHandler(() => createServer(env, machine)).fetch(request);
  }

  if (pathname === "/v1/events" && request.method === "POST") {
    if (!hasBearer(request, env.INGEST_TOKEN, env.AGENT_TOKEN)) return unauthorized();
    const event = await parseHookRequest(request);
    const result = await handleHookEvent(env, ctx, event);
    // `format=hook` answers in the harness's own hook output shape, so a shell script can print it as is.
    if (new URL(request.url).searchParams.get("format") === "hook" && result.additionalContext) {
      return json(200, { hookSpecificOutput: { hookEventName: event.event, additionalContext: result.additionalContext } });
    }
    return json(200, result);
  }

  return json(404, { error: "Not found" });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    try {
      return await route(request, env, ctx);
    } catch (error) {
      if (error instanceof UserError) return json(400, { error: error.message });
      console.error("request failed:", error instanceof Error ? error.message : error);
      return json(500, { error: "Internal error" });
    }
  },
} satisfies ExportedHandler<AppEnv>;
