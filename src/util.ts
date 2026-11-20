// Shared helpers: environment shape, JSON responses, bearer checks, hashing, time.

export type AppEnv = Env & {
  /** Bearer token for agents: the MCP endpoint, and everything the ingest token allows. */
  AGENT_TOKEN?: string;
  /** Bearer token for hook scripts: may only post events. */
  INGEST_TOKEN?: string;
  /** Chief of Staff ingest Worker, as a service binding (same account) or a URL. */
  COS?: Fetcher;
  COS_URL?: string;
  COS_INGEST_TOKEN?: string;
  /** Cloudflare Access in front of /review: the team's sign-in domain and the application's audience tag. */
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
};

export function json(status: number, data: unknown): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
}

export function iso(date: Date = new Date()): string {
  return date.toISOString();
}

/** A valid ISO timestamp from untrusted input, else the fallback. */
export function parseTime(value: unknown, fallback: Date = new Date()): Date {
  if (typeof value !== "string" || !value) return fallback;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? fallback : new Date(ms);
}

// Constant-time string compare (length leak only).
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** True when the request carries `Authorization: Bearer <one of the set secrets>`. */
export function hasBearer(request: Request, ...secrets: (string | undefined)[]): boolean {
  const header = request.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice(7);
  return secrets.some((secret) => !!secret && safeEqual(token, secret));
}

export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function truncate(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit - 1) + "…" : text;
}

export function parseList(jsonText: string | null | undefined): string[] {
  try {
    const value = JSON.parse(jsonText ?? "[]");
    return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
  } catch {
    return [];
  }
}

/** A problem the caller can fix; surfaced to the agent as a tool error or a 400. */
export class UserError extends Error {}
