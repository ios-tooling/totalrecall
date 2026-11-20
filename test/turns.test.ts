import type { Client } from "@modelcontextprotocol/client";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import { cosBody, reportToChiefOfStaff } from "../src/cos";
import type { Project } from "../src/history";
import type { Turn } from "../src/turns";
import type { AppEnv } from "../src/util";
import { AGENT, call, connect, hook, uniqueRepo } from "./helpers";

let client: Client;
beforeAll(async () => {
  client = await connect();
});

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const sessionKey = () => crypto.randomUUID();

async function activity(repoURL: string, includePrompts = false) {
  const result = await call(client, "get_activity", { since: minutesAgo(24 * 60), repoURL, includePrompts });
  return JSON.parse(result.text) as { repos: { repoURL: string; turns: number; sessions: Record<string, unknown>[]; staleUncommitted: unknown[] }[] };
}

const turnIDFrom = (context: string | undefined) => context!.match(/turnID `([^`]+)`/)![1]!;

describe("session start hook", () => {
  it("opens a session once and tells the agent what it should know", async () => {
    const repo = uniqueRepo("start");
    const key = sessionKey();
    const sessionID = (await call(client, "start_session", { repoURL: repo, agentName: "codex" })).text;
    await call(client, "update_status", { sessionID, repoURL: repo, content: "Importer half done." });
    await call(client, "log_work", { sessionID, repoURL: repo, content: "Wrote the importer skeleton." });
    await call(client, "remember", { content: "Run the importer with --dry-run first.", kind: "preference", repoURL: repo });

    const first = await hook({ event: "SessionStart", repo: `git@github.com:${repo.slice("https://github.com/".length)}.git` }, { session_id: key, cwd: "/Users/ben/dev/start", source: "startup", model: "claude-opus-5" });
    expect(first.status).toBe(200);
    const context = first.body.additionalContext!;
    const opened = context.match(/opened session `([^`]+)`/)![1]!;
    expect(opened).toMatch(/_claude(-\d+)?$/);
    expect(context).toContain(`for ${repo}. Do not call \`start_session\``);
    expect(context).toContain("[preference, ");
    expect(context).toContain("Run the importer with --dry-run first.");
    expect(context).toContain("## Current status\n\nImporter half done.");
    expect(context).toContain("(codex): Wrote the importer skeleton.");

    // A retried hook gets the same session back; a resume injects nothing.
    const again = await hook({ event: "SessionStart", repo }, { session_id: key, cwd: "/Users/ben/dev/start", source: "clear" });
    expect(again.body.additionalContext).toContain(`opened session \`${opened}\``);
    expect((await hook({ event: "SessionStart", repo }, { session_id: key, cwd: "/x", source: "resume" })).body).toEqual({});
    expect((await call(client, "list_sessions", { repoURL: repo })).text.split("\n")).toHaveLength(2);
  });
});

describe("turn lifecycle", () => {
  it("captures a turn, enriches it, and closes it with the working-tree state", async () => {
    const repo = uniqueRepo("turn");
    const key = sessionKey();
    await hook({ event: "SessionStart", repo }, { session_id: key, cwd: "/Users/ben/dev/turn", source: "startup" });
    const started = await hook({ event: "UserPromptSubmit", repo, at: minutesAgo(5) }, { session_id: key, cwd: "/Users/ben/dev/turn", prompt: "\nFix the flaky sync test\nand tell me why it failed. token ghp_abcdefghijklmnopqrstuvwxyz0123" });
    const turnID = turnIDFrom(started.body.additionalContext);
    expect(started.body.additionalContext).toContain(`sessionKey \`${key}\``);

    let report = await activity(repo, true);
    expect(report.repos).toHaveLength(1);
    expect(report.repos[0]!.sessions[0]).toMatchObject({
      sessionKey: key, agent: "claude", machine: "MBP14", folder: "/Users/ben/dev/turn", state: "working", running: true, turns: 1, uncommitted: false,
      summaries: ["Fix the flaky sync test"],
    });
    expect((report.repos[0]!.sessions[0]!.prompts as string[])[0]).toContain("token [redacted]");
    expect(report.repos[0]!.sessions[0]!.aiSessionID).toMatch(/_claude/);

    expect((await call(client, "update_work", { repoURL: repo, description: "Diagnosing the CloudKit sync flake", sessionKey: key, turnID, agentName: "claude" })).text).toBe("Turn description updated.");
    expect((await call(client, "update_work", { repoURL: repo, description: "x", sessionKey: key, turnID: "nope", agentName: "claude" })).isError).toBe(true);

    await hook({ event: "PostToolUse", repo, at: minutesAgo(3) }, { session_id: key, cwd: "/Users/ben/dev/turn" });
    await hook({ event: "Stop", repo, dirty: true, at: minutesAgo(1) }, { session_id: key, cwd: "/Users/ben/dev/turn" });
    report = await activity(repo);
    expect(report.repos[0]!.sessions[0]).toMatchObject({ state: "idle", running: false, uncommitted: true, summaries: ["Diagnosing the CloudKit sync flake"] });
    expect(report.repos[0]!.sessions[0]!.prompts).toBeUndefined();

    // The prompt and the description are both searchable.
    expect((await call(client, "search_history", { query: "flaky sync", repoURL: repo })).text).toContain("/ turn]");
    expect((await call(client, "search_history", { query: "CloudKit diagnosing", repoURL: repo })).text).toContain("«CloudKit»");

    await hook({ event: "SessionEnd", repo }, { session_id: key, cwd: "/Users/ben/dev/turn" });
    expect((await activity(repo)).repos[0]!.sessions[0]).toMatchObject({ state: "ended", running: false });
    expect((await call(client, "list_sessions", { repoURL: repo })).text).toContain("ended");
  });

  it("supersedes an unclosed turn and keeps a terminal outcome", async () => {
    const repo = uniqueRepo("supersede");
    const key = sessionKey();
    const cwd = "/Users/ben/dev/supersede";
    const first = turnIDFrom((await hook({ event: "UserPromptSubmit", repo, at: minutesAgo(10) }, { session_id: key, cwd, prompt: "first" })).body.additionalContext);
    // A repeated start for the same turn changes nothing.
    await hook({ event: "UserPromptSubmit", repo, turn: first, at: minutesAgo(9) }, { session_id: key, cwd, prompt: "first again" });
    await hook({ event: "UserPromptSubmit", repo, at: minutesAgo(8) }, { session_id: key, cwd, prompt: "second" });

    const rows = await env.DB.prepare("SELECT summary, state, end_reason FROM turns WHERE session_key = ? ORDER BY started_at").bind(key).all<{ summary: string; state: string; end_reason: string | null }>();
    expect(rows.results).toEqual([
      { summary: "first", state: "interrupted", end_reason: "Superseded by a new turn" },
      { summary: "second", state: "working", end_reason: null },
    ]);

    await hook({ event: "Interrupt", repo, at: minutesAgo(7) }, { session_id: key, cwd });
    await hook({ event: "Stop", repo, at: minutesAgo(6) }, { session_id: key, cwd });
    const second = await env.DB.prepare("SELECT state, end_reason FROM turns WHERE session_key = ? AND summary = 'second'").bind(key).first();
    expect(second).toEqual({ state: "interrupted", end_reason: "Interrupt" });

    const failed = sessionKey();
    await hook({ event: "UserPromptSubmit", repo, agent: "codex", at: minutesAgo(5) }, { session_id: failed, cwd, prompt: "third", turn_id: "codex-turn-1" });
    await hook({ event: "StopFailure", repo, agent: "codex", at: minutesAgo(4) }, { session_id: failed, cwd, turn_id: "codex-turn-1", error: "rate limited" });
    expect(await env.DB.prepare("SELECT state, end_reason, turn_id FROM turns WHERE session_key = ?").bind(failed).first()).toEqual({ state: "failed", end_reason: "rate limited", turn_id: "codex-turn-1" });
  });

  it("reports stale dirty checkouts and treats silent working turns as idle", async () => {
    const repo = uniqueRepo("stale");
    const cwd = "/Users/ben/dev/stale";
    const dirty = sessionKey();
    await hook({ event: "UserPromptSubmit", repo, at: minutesAgo(3 * 24 * 60) }, { session_id: dirty, cwd, prompt: "left dirty" });
    await hook({ event: "Stop", repo, dirty: true, at: minutesAgo(3 * 24 * 60 - 5) }, { session_id: dirty, cwd });
    const orphan = sessionKey();
    await hook({ event: "UserPromptSubmit", repo, at: minutesAgo(120) }, { session_id: orphan, cwd, prompt: "orphaned" });

    const report = await activity(repo);
    expect(report.repos[0]!.turns).toBe(1);
    expect(report.repos[0]!.sessions[0]).toMatchObject({ sessionKey: orphan, state: "idle", running: false });
    expect(report.repos[0]!.staleUncommitted).toEqual([{ sessionKey: dirty, lastActivity: expect.stringMatching(/Z$/) }]);
  });

  it("rejects malformed hook posts without failing the caller's turn silently", async () => {
    expect((await hook({ event: "Stop", repo: uniqueRepo() }, { cwd: "/x" })).status).toBe(400);
    expect((await hook({ event: "SomethingNew", repo: uniqueRepo() }, { session_id: "s", cwd: "/x" })).body).toEqual({});
    expect((await hook({ event: "Stop", repo: uniqueRepo() }, { session_id: "s", cwd: "/x" }, AGENT)).status).toBe(200);
  });
});

describe("chief of staff forwarding", () => {
  const project: Project = { id: 1, identity_key: "bengottlieb_devcenter", repo_url: "https://github.com/bengottlieb/DevCenter", display_name: "DevCenter", status: null, status_updated_at: null };
  const turn = (overrides: Partial<Turn> = {}): Turn => ({
    id: "turn_x", project_id: 1, session_pk: null, agent: "claude", machine: "MBP14", machine_name: "Ben's MacBook Pro", session_key: `cos-${crypto.randomUUID()}`,
    turn_id: "t1", summary: "Fix the build", prompt: "Fix the build", description: null, folder_path: "/Users/ben/dev/DevCenter", state: "idle", end_reason: null,
    uncommitted: 1, started_at: "2026-11-20T13:00:00.000Z", last_activity_at: "2026-11-20T13:05:00.000Z", ended_at: null, ...overrides,
  });

  it("posts the payload Chief of Staff's collector reads", () => {
    const t = turn({ session_key: "abc" });
    expect(cosBody(t, project, new Date("2026-11-20T13:05:09.123Z"))).toEqual({
      source: "hook", kind: "session", repo: "bengottlieb/DevCenter", machine: "MBP14", at: "2026-11-20T13:05:09Z", dedupe: "hook:abc:2026-11-20T13:05:09Z",
      payload: {
        repoURL: "https://github.com/bengottlieb/DevCenter", machineID: "MBP14", machineName: "Ben's MacBook Pro", agentName: "claude", sessionKey: "abc",
        summary: "Fix the build", hasUncommittedChanges: true, state: "idle", folderPath: "/Users/ben/dev/DevCenter",
      },
    });
  });

  it("throttles per session unless the dirty flag changes or the session ends", async () => {
    const posts: { url: string; auth: string | null }[] = [];
    const cos = { fetch: async (url: string, init: RequestInit) => (posts.push({ url, auth: new Headers(init.headers).get("authorization") }), new Response("{}", { status: 201 })) };
    const fake = { DB: env.DB, COS: cos, COS_INGEST_TOKEN: "ingest" } as unknown as AppEnv;
    const t = turn();
    const at = new Date("2026-11-20T13:05:00Z");
    await reportToChiefOfStaff(fake, t, project, false, at);
    await reportToChiefOfStaff(fake, t, project, false, new Date(at.getTime() + 60_000));
    expect(posts).toEqual([{ url: "https://chief-of-staff/events", auth: "Bearer ingest" }]);
    await reportToChiefOfStaff(fake, { ...t, uncommitted: 0 }, project, false, new Date(at.getTime() + 120_000));
    await reportToChiefOfStaff(fake, { ...t, uncommitted: 0 }, project, false, new Date(at.getTime() + 31 * 60_000 + 120_000));
    await reportToChiefOfStaff(fake, { ...t, uncommitted: 0 }, project, true, new Date(at.getTime() + 32 * 60_000 + 120_000));
    expect(posts).toHaveLength(4);
    // Unconfigured: nothing is sent.
    await reportToChiefOfStaff({ DB: env.DB } as unknown as AppEnv, turn(), project, true, at);
    expect(posts).toHaveLength(4);
  });
});
