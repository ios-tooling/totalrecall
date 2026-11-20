import type { Client } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { handleReview } from "../src/review/api";
import type { AppEnv } from "../src/util";
import { AGENT, call, connect, hook, uniqueRepo, workerFetch } from "./helpers";

const TEAM = "team.test";
const AUDIENCE = "test-review-audience";
const EMAIL = "reviewer@example.test";

const base64url = (bytes: ArrayBuffer | Uint8Array | string) => {
  const array = typeof bytes === "string" ? new TextEncoder().encode(bytes) : new Uint8Array(bytes);
  return btoa(String.fromCharCode(...array)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
};

const rsa = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
let signingKey: CryptoKey;
let strangerKey: CryptoKey;
let client: Client;

async function token(claims: Record<string, unknown> = {}, options: { key?: CryptoKey; header?: Record<string, unknown> } = {}): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT", ...options.header }));
  const body = base64url(JSON.stringify({ iss: `https://${TEAM}`, aud: [AUDIENCE], email: EMAIL, iat: now, nbf: now, exp: now + 600, ...claims }));
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", options.key ?? signingKey, new TextEncoder().encode(`${header}.${body}`));
  return `${header}.${body}.${base64url(signature)}`;
}

const review = async (path: string, jwt?: string, init: RequestInit = {}) =>
  workerFetch(`/review${path}`, { ...init, headers: { ...(jwt ? { "cf-access-jwt-assertion": jwt } : {}), ...init.headers } });

async function get<T = Record<string, any>>(path: string): Promise<T> {
  const response = await review(`/api/${path}`, await token());
  expect(response.status, path).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return response.json();
}

beforeAll(async () => {
  const pair = (await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair;
  signingKey = pair.privateKey;
  strangerKey = ((await crypto.subtle.generateKey(rsa, true, ["sign", "verify"])) as CryptoKeyPair).privateKey;
  const published = { ...((await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey), kid: "key-1" };
  // Access publishes its signing keys at a well-known address; nothing else may be fetched.
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (url === `https://${TEAM}/cdn-cgi/access/certs`) return Response.json({ keys: [published] });
    throw new Error(`unexpected outbound request to ${url}`);
  });
  client = await connect();
});

describe("who may review", () => {
  it("is closed until Access is configured", async () => {
    for (const unset of [{ ACCESS_AUD: "" }, { ACCESS_TEAM_DOMAIN: " " }]) {
      const response = await handleReview(new Request("https://total-recall.test/review", { headers: { "cf-access-jwt-assertion": await token() } }), { ...env, ...unset } as AppEnv);
      expect(response.status).toBe(404);
    }
  });

  it("turns away everything but a current token for this application, signed by the team", async () => {
    const past = Math.floor(Date.now() / 1000) - 60;
    const refused: [string, string | undefined][] = [
      ["no token", undefined],
      ["not a token", "not.a.token"],
      ["another application's token", await token({ aud: ["some-other-app"] })],
      ["an expired token", await token({ exp: past })],
      ["a token from another team", await token({ iss: "https://elsewhere.test" })],
      ["a token signed by someone else", await token({}, { key: strangerKey })],
      ["an unsigned token", (await token({}, { header: { alg: "none" } })).replace(/\.[^.]*$/, ".")],
      ["a key the team never published", await token({}, { header: { kid: "key-2" } })],
      ["a token with no person in it", await token({ email: undefined })],
    ];
    for (const [what, jwt] of refused) {
      for (const path of ["", "/api/overview"]) expect((await review(path, jwt)).status, `${what} ${path}`).toBe(403);
    }
    // The agent's bearer token is for MCP; it does not open the review pages.
    expect((await workerFetch("/review/api/overview", { headers: { authorization: `Bearer ${AGENT}` } })).status).toBe(403);
  });

  it("lets a signed-in person read, by header or cookie, and nothing more", async () => {
    expect((await review("/api/me", await token())).status).toBe(200);
    expect(await get("me")).toEqual({ email: EMAIL });
    const viaCookie = await workerFetch("/review/api/me", { headers: { cookie: `other=1; CF_Authorization=${await token()}` } });
    expect(await viaCookie.json()).toEqual({ email: EMAIL });
    expect((await review("/api/overview", await token(), { method: "POST" })).status).toBe(405);
    expect((await review("/api/nonsense", await token())).status).toBe(404);
    expect((await review("/elsewhere", await token())).status).toBe(404);
  });

  it("serves one self-contained page that can only run its own script", async () => {
    const response = await review("", await token());
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    const html = await response.text();
    const policy = response.headers.get("content-security-policy")!;
    const nonce = policy.match(/script-src 'nonce-([^']+)'/)![1]!;
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain("connect-src 'self'");
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).not.toContain("__NONCE__");
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toMatch(/innerHTML|insertAdjacentHTML|document\.write/);
    // A fresh nonce every time.
    expect((await review("/", await token())).headers.get("content-security-policy")).not.toBe(policy);
  });
});

describe("what is shown", () => {
  it("lists a project with its status, sessions, entries, memories and turns", async () => {
    const repoURL = uniqueRepo("review");
    const marker = `quokka${Date.now().toString(36)}`;
    const sessionID = (await call(client, "start_session", { repoURL, agentName: "claude", model: "claude-opus-5", machine: "MBP14" })).text;
    await call(client, "log_work", { sessionID, repoURL, content: `Built the ${marker} importer.`, inputTokens: 10, commits: ["abc1234"] });
    await call(client, "update_status", { sessionID, repoURL, content: "Importer done; exporter next." });
    await call(client, "attach_file", { sessionID, repoURL, filename: "plan.md", content: "the plan" });
    const kept = Number((await call(client, "remember", { content: `Always dry-run the ${marker} importer.`, kind: "preference", repoURL })).text.match(/#(\d+)/)![1]);
    const dropped = Number((await call(client, "remember", { content: "A fact that turned out wrong.", kind: "fact", repoURL })).text.match(/#(\d+)/)![1]);
    await call(client, "forget", { id: dropped, reason: "was wrong" });
    const key = crypto.randomUUID();
    await hook({ event: "UserPromptSubmit", repo: repoURL }, { session_id: key, cwd: "/Users/ben/dev/review", prompt: `Please <b>finish</b> the ${marker} exporter` });
    await hook({ event: "Stop", repo: repoURL, dirty: true }, { session_id: key, cwd: "/Users/ben/dev/review" });

    const { projects } = await get("projects");
    const listed = projects.find((p: any) => p.repo_url === repoURL);
    expect(listed).toMatchObject({ sessions: 1, entries: 3, turns: 1, memories: 1 });
    // Newest activity first.
    expect(projects[0].repo_url).toBe(repoURL);

    const detail = await get(`projects/${listed.id}`);
    expect(detail.project.status).toBe("Importer done; exporter next.");
    expect(detail.sessions).toHaveLength(1);
    expect(detail.sessions[0]).toMatchObject({ session_id: sessionID, agent: "claude", machine: "MBP14", model: "claude-opus-5", entries: 3, input_tokens: 10 });
    expect(detail.memories.map((m: any) => [m.id, m.retired_at === null, m.retired_reason])).toEqual([[kept, true, null], [dropped, false, "was wrong"]]);
    expect(detail.turns[0]).toMatchObject({ summary: `Please <b>finish</b> the ${marker} exporter`, state: "idle", uncommitted: 1, machine: "MBP14", project: listed.display_name });

    const session = await get(`sessions/${detail.sessions[0].id}`);
    expect(session.session).toMatchObject({ session_id: sessionID, project: listed.display_name, repo_url: repoURL });
    expect(session.entries.map((e: any) => [e.kind, e.title, e.content])).toEqual([
      ["work", null, `Built the ${marker} importer.`], ["status", null, "Importer done; exporter next."], ["attachment", "plan.md", "the plan"],
    ]);
    expect(JSON.parse(session.entries[0].commits)).toEqual(["abc1234"]);

    const active = await get("memories");
    expect(active.memories.some((m: any) => m.id === kept && m.project === listed.display_name)).toBe(true);
    expect(active.memories.some((m: any) => m.id === dropped)).toBe(false);
    expect((await get("memories?state=retired")).memories.some((m: any) => m.id === dropped)).toBe(true);
    expect((await get("memories?state=all")).memories.filter((m: any) => [kept, dropped].includes(m.id))).toHaveLength(2);

    const overview = await get("overview");
    expect(overview.counts.projects).toBeGreaterThanOrEqual(1);
    expect(overview.counts.retiredMemories).toBeGreaterThanOrEqual(1);
    expect(overview.turns[0].session_key).toBe(key);
    expect(overview.entries[0]).toMatchObject({ kind: "status", project: listed.display_name, session: sessionID });
    expect(overview.entries.some((e: any) => e.kind === "attachment")).toBe(false);

    // Search points back at what it found, and can be kept to one project.
    const { hits } = await get(`search?q=${marker}`);
    expect(hits.map((h: any) => h.source).sort()).toEqual(["entry", "memory", "turn"]);
    const entry = hits.find((h: any) => h.source === "entry");
    expect(entry).toMatchObject({ projectID: listed.id, sessionPK: detail.sessions[0].id, session: sessionID, kind: "work" });
    expect(entry.snippet).toContain(`«${marker}»`);
    expect(hits.find((h: any) => h.source === "memory").id).toBe(kept);
    expect((await get(`search?q=${marker}&project=${listed.id + 100000}`)).hits).toEqual([]);
    expect((await get("search?q=")).hits).toEqual([]);

    expect((await review("/api/projects/999999999", await token())).status).toBe(404);
    expect((await review("/api/sessions/abc", await token())).status).toBe(404);
  });

  it("pages through turns, newest first, optionally for one project", async () => {
    const repoURL = uniqueRepo("review-turns");
    const cwd = "/Users/ben/dev/review-turns";
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
    for (const [i, minutes] of [30, 20, 10].entries()) {
      await hook({ event: "UserPromptSubmit", repo: repoURL, at: minutesAgo(minutes) }, { session_id: `paging-${repoURL}-${i}`, cwd, prompt: `turn ${i}` });
    }
    const { projects } = await get("projects");
    const id = projects.find((p: any) => p.repo_url === repoURL).id;

    const first = await get(`turns?project=${id}&limit=2`);
    expect(first.turns.map((t: any) => t.summary)).toEqual(["turn 2", "turn 1"]);
    const second = await get(`turns?project=${id}&limit=2&before=${encodeURIComponent(first.turns[1].last_activity_at)}`);
    expect(second.turns.map((t: any) => t.summary)).toEqual(["turn 0"]);
    const everywhere = await get("turns?limit=200");
    expect(everywhere.turns.filter((t: any) => t.project_id === id)).toHaveLength(3);
  });
});
