// Who is signed in through Cloudflare Access. The review interface sits behind an Access
// application; this verifies the token Access attaches to every request it lets through,
// so the pages stay closed even if that application were removed or misconfigured.

import type { AppEnv } from "./util";

export interface AccessIdentity {
  email: string;
}

type SigningKey = JsonWebKey & { kid?: string };

const KEY_LIFETIME_MS = 60 * 60 * 1000;
let cached: { team: string; fetchedAt: number; keys: SigningKey[] } | null = null;

/** `name.cloudflareaccess.com` means https; a full origin is taken as given, for a stand-in issuer in local development. */
const issuerOf = (team: string) => (team.includes("://") ? team.replace(/\/+$/, "") : `https://${team}`);

/** The team's current signing keys. Access rotates them, so a miss is worth one fresh look. */
async function signingKeys(team: string, refresh: boolean): Promise<SigningKey[]> {
  if (!refresh && cached && cached.team === team && Date.now() - cached.fetchedAt < KEY_LIFETIME_MS) return cached.keys;
  const response = await fetch(`${issuerOf(team)}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access signing keys: HTTP ${response.status}`);
  const body = (await response.json()) as { keys?: SigningKey[] };
  cached = { team, fetchedAt: Date.now(), keys: body.keys ?? [] };
  return cached.keys;
}

function decodeBase64URL(segment: string): Uint8Array<ArrayBuffer> {
  const base64 = segment.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(segment.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

const decodeJSON = (segment: string) => JSON.parse(new TextDecoder().decode(decodeBase64URL(segment)));

function cookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return null;
}

export const accessConfigured = (env: AppEnv) => !!env.ACCESS_TEAM_DOMAIN?.trim() && !!env.ACCESS_AUD?.trim();

/** The person Access signed in, or null for anything short of a valid, current token for this application. */
export async function accessIdentity(request: Request, env: AppEnv): Promise<AccessIdentity | null> {
  const team = env.ACCESS_TEAM_DOMAIN?.trim();
  const audience = env.ACCESS_AUD?.trim();
  if (!team || !audience) return null;
  const token = request.headers.get("cf-access-jwt-assertion") ?? cookie(request, "CF_Authorization");
  const parts = token?.split(".") ?? [];
  if (parts.length !== 3) return null;
  const [head, body, signature] = parts as [string, string, string];
  try {
    const header = decodeJSON(head) as { alg?: string; kid?: string };
    const claims = decodeJSON(body) as { aud?: string | string[]; exp?: number; nbf?: number; iss?: string; email?: string };
    const now = Math.floor(Date.now() / 1000);
    if (header.alg !== "RS256" || !header.kid) return null;
    if (typeof claims.exp !== "number" || claims.exp <= now) return null;
    if (typeof claims.nbf === "number" && claims.nbf > now + 60) return null;
    if (claims.iss !== issuerOf(team)) return null;
    if (![claims.aud].flat().includes(audience)) return null;

    const find = (keys: SigningKey[]) => keys.find((key) => key.kid === header.kid);
    const jwk = find(await signingKeys(team, false)) ?? find(await signingKeys(team, true));
    if (!jwk) return null;
    const key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    const signed = new TextEncoder().encode(`${head}.${body}`);
    const valid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, decodeBase64URL(signature), signed);
    return valid && typeof claims.email === "string" && claims.email ? { email: claims.email } : null;
  } catch (error) {
    console.error("access check failed:", error instanceof Error ? error.message : error);
    return null;
  }
}
