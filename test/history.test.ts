import type { Client } from "@modelcontextprotocol/client";
import { beforeAll, describe, expect, it } from "vitest";
import { AGENT, INGEST, call, connect, uniqueRepo, workerFetch } from "./helpers";

let client: Client;
beforeAll(async () => {
  client = await connect(AGENT, "MBP14");
});

describe("auth", () => {
  it("answers health without a token and nothing else", async () => {
    expect((await workerFetch("/")).status).toBe(200);
    expect((await workerFetch("/mcp", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await workerFetch("/v1/events?event=Stop", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await workerFetch("/nope")).status).toBe(404);
  });

  it("does not let the hook token read history over MCP", async () => {
    const response = await workerFetch("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${INGEST}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });
});

describe("history tools", () => {
  it("lists the AIHistoryKit tool names plus the memory tools", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(
      ["attach_file", "end_session", "forget", "get_activity", "get_project_context", "list_sessions", "log_work", "recall", "remember", "search_history", "start_session", "update_status", "update_work"].sort(),
    );
  });

  it("records a session from start to end", async () => {
    const repoURL = uniqueRepo("flow");
    const started = await call(client, "start_session", { repoURL, agentName: "claude", model: "claude-opus-5" });
    expect(started.isError).toBe(false);
    const sessionID = started.text;
    expect(sessionID).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}_claude$/);

    expect((await call(client, "log_work", { sessionID, repoURL, content: "Ported the redactor to TypeScript.", inputTokens: 100, outputTokens: 20, commits: ["abc1234"] })).text).toBe("Work logged.");
    expect((await call(client, "update_status", { sessionID, repoURL, content: "Worker scaffolded; deploy pending." })).text).toBe("Status updated.");
    expect((await call(client, "attach_file", { sessionID, repoURL, filename: "notes.md", content: "attachment body" })).text).toBe("File attached: notes.md");

    const open = await call(client, "list_sessions", { repoURL });
    expect(open.text).toBe(`- ${sessionID} [claude on MBP14] open, tokens: 120`);

    // end_session reports totals, so they replace rather than add to what log_work recorded.
    expect((await call(client, "end_session", { sessionID, repoURL, summary: "Phase one done.", inputTokens: 150, outputTokens: 30, commits: ["abc1234", "def5678"] })).text).toBe("Session ended.");
    expect((await call(client, "list_sessions", { repoURL })).text).toBe(`- ${sessionID} [claude on MBP14] ended, tokens: 180`);

    const context = (await call(client, "get_project_context", { repoURL })).text;
    expect(context).toContain("## Current Status\n\nWorker scaffolded; deploy pending.");
    expect(context).toContain(`### Session: ${sessionID} (claude, MBP14)`);
    expect(context).toContain("Ported the redactor to TypeScript.");
    expect(context).toContain("*Commits: abc1234*");
    expect(context).toContain("(session summary)\n\nPhase one done.");
    expect(context).not.toContain("attachment body");
  });

  it("treats every spelling of a repo as one project", async () => {
    const name = `spelling-${Date.now().toString(36)}`;
    const https = `https://github.com/Tests/${name}`;
    const ssh = `git@github.com:tests/${name}.git`;
    const sessionID = (await call(client, "start_session", { repoURL: https, agentName: "codex" })).text;
    expect((await call(client, "log_work", { sessionID, repoURL: ssh, content: "Logged over the SSH spelling." })).isError).toBe(false);
    expect((await call(client, "get_project_context", { repoURL: ssh })).text).toContain("Logged over the SSH spelling.");
  });

  it("gives two sessions started in the same minute different ids", async () => {
    const repoURL = uniqueRepo("minute");
    const first = (await call(client, "start_session", { repoURL, agentName: "claude" })).text;
    const second = (await call(client, "start_session", { repoURL, agentName: "claude" })).text;
    expect(second).not.toBe(first);
    expect(second.startsWith(first.slice(0, 16))).toBe(true);
  });

  it("explains an unknown session instead of silently dropping the work", async () => {
    const repoURL = uniqueRepo("unknown");
    const result = await call(client, "log_work", { sessionID: "2026-01-01T00-00_claude", repoURL, content: "lost?" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Call start_session first");
    expect((await call(client, "get_project_context", { repoURL })).text).toBe("No history yet.");
  });

  it("never stores a secret", async () => {
    const repoURL = uniqueRepo("secrets");
    const sessionID = (await call(client, "start_session", { repoURL, agentName: "claude" })).text;
    await call(client, "log_work", { sessionID, repoURL, content: "Rotated the deploy credential ghp_abcdefghijklmnopqrstuvwxyz0123 today." });
    const context = (await call(client, "get_project_context", { repoURL })).text;
    expect(context).toContain("Rotated the deploy credential [redacted] today.");
    expect(context).not.toContain("ghp_");
  });
});

describe("search", () => {
  it("ranks matches across projects, scopes to one, and survives punctuation", async () => {
    const marker = `zebrafish${Date.now().toString(36)}`;
    const one = uniqueRepo("search-one");
    const two = uniqueRepo("search-two");
    const s1 = (await call(client, "start_session", { repoURL: one, agentName: "claude" })).text;
    const s2 = (await call(client, "start_session", { repoURL: two, agentName: "claude" })).text;
    await call(client, "log_work", { sessionID: s1, repoURL: one, content: `Migrated the ${marker} importer to streaming.` });
    await call(client, "log_work", { sessionID: s2, repoURL: two, content: `Unrelated note that mentions ${marker} once, among many other words about caching.` });

    const everywhere = (await call(client, "search_history", { query: marker })).text;
    expect(everywhere).toContain(`«${marker}»`);
    expect(everywhere.split("\n\n")).toHaveLength(2);

    const scoped = (await call(client, "search_history", { query: `${marker} importer`, repoURL: one })).text;
    expect(scoped.split("\n\n")).toHaveLength(1);
    expect(scoped).toContain(`/ ${s1} / work]`);

    // Stemming: "migrating" finds "Migrated". Punctuation is not FTS syntax.
    expect((await call(client, "search_history", { query: `"migrating" (${marker}`, repoURL: one })).text).toContain("importer");
    expect((await call(client, "search_history", { query: "?!*" })).text).toBe("No matches.");
    expect((await call(client, "search_history", { query: marker, repoURL: uniqueRepo("empty") })).text).toBe("No matches.");
  });
});

describe("memory", () => {
  it("remembers, recalls by scope, supersedes and forgets", async () => {
    const repoURL = uniqueRepo("memory");
    const other = uniqueRepo("memory-other");
    const tag = `m${Date.now().toString(36)}`;
    const project = await call(client, "remember", { content: `${tag}: use swift-testing, not XCTest, in this repo.`, kind: "decision", repoURL });
    const global = await call(client, "remember", { content: `${tag}: never add AI attribution to commit messages.`, kind: "correction" });
    const projectID = Number(project.text.match(/#(\d+)/)![1]);
    const globalID = Number(global.text.match(/#(\d+)/)![1]);

    const here = (await call(client, "recall", { repoURL })).text;
    expect(here).toContain(`#${projectID} [decision, `);
    expect(here).toContain(`#${globalID} [correction, global]`);
    // Corrections come first.
    expect(here.indexOf(`#${globalID} `)).toBeLessThan(here.indexOf(`#${projectID} `));
    const elsewhere = (await call(client, "recall", { repoURL: other })).text;
    expect(elsewhere).toContain(`#${globalID} `);
    expect(elsewhere).not.toContain(`#${projectID} `);

    expect((await call(client, "get_project_context", { repoURL })).text).toContain(`## Memories\n\n- #${globalID} [correction, global]`);

    const replaced = await call(client, "remember", { content: `${tag}: use XCTest here after all; swift-testing breaks the CI image.`, kind: "decision", repoURL, supersedes: projectID });
    const replacementID = Number(replaced.text.match(/#(\d+)/)![1]);
    const after = (await call(client, "recall", { repoURL })).text;
    expect(after).toContain(`#${replacementID} `);
    expect(after).not.toContain(`#${projectID} `);
    // A retired memory no longer turns up in search either.
    expect((await call(client, "search_history", { query: `${tag} swift-testing XCTest`, repoURL })).text.match(/memory\]/g)).toHaveLength(1);

    expect((await call(client, "forget", { id: globalID, reason: "test cleanup" })).text).toBe(`Memory #${globalID} retired.`);
    expect((await call(client, "recall", { repoURL })).text).not.toContain(`#${globalID} `);
    expect((await call(client, "forget", { id: globalID })).isError).toBe(true);
    expect((await call(client, "remember", { content: "x", kind: "fact", supersedes: 99999999 })).isError).toBe(true);
  });
});
