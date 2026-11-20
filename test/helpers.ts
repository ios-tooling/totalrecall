import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { exports } from "cloudflare:workers";

export const BASE = "https://totalrecall.test";
export const AGENT = "test-agent-token";
export const INGEST = "test-ingest-token";

let counter = 0;
/** A repo no other test touches: the database is shared across a test file. */
export const uniqueRepo = (name = "repo") => `https://github.com/tests/${name}-${Date.now().toString(36)}-${++counter}`;

export function workerFetch(input: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(input.startsWith("http") ? input : BASE + input, init));
}

export async function connect(token = AGENT, machine?: string): Promise<Client> {
  const client = new Client({ name: "totalrecall-tests", version: "1.0.0" });
  const headers: Record<string, string> = { authorization: `Bearer ${token}` };
  if (machine) headers["x-totalrecall-machine"] = machine;
  const transport = new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), {
    requestInit: { headers },
    fetch: (input, init) => exports.default.fetch(new Request(input as RequestInfo, init)),
  });
  await client.connect(transport);
  return client;
}

export async function call(client: Client, name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
  const result = await client.callTool({ name, arguments: args });
  const first = (result.content as { type: string; text?: string }[])[0];
  return { text: first?.text ?? "", isError: result.isError === true };
}

export interface HookParams {
  event: string;
  repo: string;
  agent?: string;
  machine?: string;
  dirty?: boolean;
  turn?: string;
  at?: string;
}

export async function hook(params: HookParams, payload: Record<string, unknown>, token = INGEST): Promise<{ status: number; body: { additionalContext?: string; error?: string } }> {
  const query = new URLSearchParams({ event: params.event, repo: params.repo, agent: params.agent ?? "claude", machine: params.machine ?? "MBP14" });
  if (params.dirty !== undefined) query.set("dirty", params.dirty ? "1" : "0");
  if (params.turn) query.set("turn", params.turn);
  if (params.at) query.set("at", params.at);
  const response = await workerFetch(`/v1/events?${query}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: response.status, body: await response.json() };
}
