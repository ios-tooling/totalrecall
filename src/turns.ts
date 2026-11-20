// Turn capture: applies Claude Code and Codex hook events to the `turns` table and to the
// session the SessionStart hook opened. Deterministic by design: hooks fire every turn
// whether or not the agent remembers to call a tool. Ported from AIHistoryKit's
// ActiveWorkHookHandler and ActiveWorkStore.

import { buildSessionContext } from "./context";
import { reportToChiefOfStaff } from "./cos";
import { type Project, type Session, ensureProject, startSession } from "./history";
import { firstLine, redact } from "./redact";
import { identityKey } from "./repo";
import { type AppEnv, UserError, iso, parseTime, sha256 } from "./util";

export type TurnState = "working" | "idle" | "ended" | "interrupted" | "failed";

export interface Turn {
  id: string;
  project_id: number;
  session_pk: number | null;
  agent: string;
  machine: string;
  machine_name: string | null;
  session_key: string;
  turn_id: string;
  summary: string;
  prompt: string | null;
  description: string | null;
  folder_path: string | null;
  state: TurnState;
  end_reason: string | null;
  uncommitted: number | null;
  started_at: string;
  last_activity_at: string;
  ended_at: string | null;
}

/** What a hook script posts: the harness's own payload plus what only the client knows. */
export interface HookEvent {
  event: string;
  agent: string;
  machine: string;
  machineName: string | null;
  /** The checkout's git remote, or its path when it has none. */
  repo: string;
  /** `git status --porcelain` was non-empty, when the client checked. */
  uncommitted: boolean | null;
  /** Client-generated turn id, for harnesses that do not supply one. */
  turnID: string | null;
  at: Date;
  hook: Record<string, unknown>;
}

export interface HookResult {
  additionalContext?: string;
}

/** A busy turn records at most one activity bump per minute. */
const HEARTBEAT_MS = 60_000;
const MAX_PROMPT = 200_000;

const text = (value: unknown): string => (typeof value === "string" ? value : "");

export async function turnPK(repo: string, machine: string, agent: string, sessionKey: string, turnID: string): Promise<string> {
  return "turn_" + (await sha256([identityKey(repo), machine, agent, sessionKey, turnID].map((part) => `${part.length}:${part}`).join("|")));
}

/** The session's newest turn, or the named one. */
async function currentTurn(db: D1Database, e: HookEvent, sessionKey: string, turnID: string | null): Promise<Turn | null> {
  if (turnID) {
    const exact = await db.prepare("SELECT * FROM turns WHERE id = ?").bind(await turnPK(e.repo, e.machine, e.agent, sessionKey, turnID)).first<Turn>();
    if (exact) return exact;
  }
  return db
    .prepare("SELECT * FROM turns WHERE session_key = ? AND agent = ? AND machine = ? ORDER BY started_at DESC LIMIT 1")
    .bind(sessionKey, e.agent, e.machine)
    .first<Turn>();
}

/**
 * The session for a harness conversation, opened the first time any hook mentions it.
 * SessionStart is not the only way in: hooks can begin firing in a conversation that was
 * already running when they were installed, or that is being resumed. Turns captured
 * before the session existed are attached to it.
 */
async function sessionFor(db: D1Database, e: HookEvent, project: Project, sessionKey: string): Promise<Session> {
  const { session } = await startSession(db, {
    repoURL: e.repo, agent: e.agent, model: text(e.hook.model) || null, machine: e.machine || null, harnessSessionID: sessionKey, at: e.at,
  });
  await db
    .prepare("UPDATE turns SET session_pk = ? WHERE project_id = ? AND session_key = ? AND session_pk IS NULL")
    .bind(session.id, project.id, sessionKey)
    .run();
  return session;
}

async function startTurn(db: D1Database, e: HookEvent, project: Project, sessionKey: string, turnID: string): Promise<void> {
  const id = await turnPK(e.repo, e.machine, e.agent, sessionKey, turnID);
  // A duplicate start must not reopen a stopped turn.
  if (await db.prepare("SELECT id FROM turns WHERE id = ?").bind(id).first()) return;
  const at = iso(e.at);
  const prompt = redact(text(e.hook.prompt)).slice(0, MAX_PROMPT);
  const session = await sessionFor(db, e, project, sessionKey);
  await db.batch([
    // A new turn supersedes an unclosed turn in this exact harness session only.
    db
      .prepare(
        `UPDATE turns SET state = 'interrupted', end_reason = 'Superseded by a new turn', last_activity_at = ?
         WHERE session_key = ? AND agent = ? AND machine = ? AND state = 'working'`,
      )
      .bind(at, sessionKey, e.agent, e.machine),
    db
      .prepare(
        `INSERT INTO turns (id, project_id, session_pk, agent, machine, machine_name, session_key, turn_id, summary, prompt,
                            folder_path, state, started_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'working', ?, ?)`,
      )
      .bind(id, project.id, session.id, e.agent, e.machine, e.machineName, sessionKey, turnID, firstLine(prompt), prompt, text(e.hook.cwd) || null, at, at),
  ]);
}

async function finishTurn(db: D1Database, e: HookEvent, sessionKey: string, turnID: string | null, state: TurnState, reason: string | null): Promise<void> {
  const turn = await currentTurn(db, e, sessionKey, turnID);
  // A delayed Stop after Interrupt or StopFailure cannot replace the turn's outcome.
  if (!turn || turn.state !== "working" || turn.ended_at) return;
  const at = iso(e.at) > turn.last_activity_at ? iso(e.at) : turn.last_activity_at;
  await db
    .prepare("UPDATE turns SET state = ?, end_reason = ?, uncommitted = ?, last_activity_at = ? WHERE id = ? AND state = 'working'")
    .bind(state, reason, e.uncommitted === null ? null : e.uncommitted ? 1 : 0, at, turn.id)
    .run();
}

async function report(env: AppEnv, e: HookEvent, project: Project, sessionKey: string, turnID: string | null, sessionEnded: boolean): Promise<void> {
  try {
    const turn = await currentTurn(env.DB, e, sessionKey, turnID);
    if (turn) await reportToChiefOfStaff(env, turn, project, sessionEnded, e.at);
  } catch (error) {
    console.error("chief of staff report failed:", error instanceof Error ? error.message : error);
  }
}

/** Applies one hook event. Unknown events are ignored: a hook must never break the turn it rides on. */
export async function handleHookEvent(env: AppEnv, ctx: ExecutionContext, e: HookEvent): Promise<HookResult> {
  const db = env.DB;
  const sessionKey = text(e.hook.session_id);
  if (!sessionKey) throw new UserError("hook.session_id is required");
  if (!e.repo) throw new UserError("repo is required");
  const project = await ensureProject(db, e.repo, e.at);
  const turnID = e.turnID || text(e.hook.turn_id) || null;
  const at = iso(e.at);

  switch (e.event) {
    case "SessionStart": {
      const source = text(e.hook.source) || "startup";
      const known = await db
        .prepare("SELECT id FROM sessions WHERE project_id = ? AND harness_session_id = ? LIMIT 1")
        .bind(project.id, sessionKey)
        .first();
      // A resumed or compacted conversation already has its context. One never seen
      // before needs it whatever the source: it predates the hooks.
      if (known && source !== "startup" && source !== "clear") return {};
      const session = await sessionFor(db, e, project, sessionKey);
      return { additionalContext: await buildSessionContext(db, project, session) };
    }
    case "UserPromptSubmit": {
      const id = turnID ?? crypto.randomUUID();
      await startTurn(db, e, project, sessionKey, id);
      return {
        additionalContext: `Turn captured by Total Recall. Optional update_work enrichment must include sessionKey \`${sessionKey}\`, turnID \`${id}\`, agentName \`${e.agent}\`, repoURL \`${project.repo_url}\`.`,
      };
    }
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure": {
      if (e.event === "PostToolUseFailure" && e.hook.is_interrupt === true) {
        await finishTurn(db, e, sessionKey, turnID, "interrupted", "Tool aborted");
        return {};
      }
      const turn = await currentTurn(db, e, sessionKey, turnID);
      if (turn?.state === "working" && e.at.getTime() - Date.parse(turn.last_activity_at) >= HEARTBEAT_MS) {
        await db.prepare("UPDATE turns SET last_activity_at = ? WHERE id = ? AND state = 'working'").bind(at, turn.id).run();
      }
      return {};
    }
    case "Stop":
    case "StopFailure":
    case "Interrupt": {
      const state: TurnState = e.event === "StopFailure" ? "failed" : e.event === "Interrupt" ? "interrupted" : "idle";
      await finishTurn(db, e, sessionKey, turnID, state, text(e.hook.error) || (e.event === "Stop" ? null : e.event));
      // The session is alive again: a turn just finished in it.
      await db
        .prepare("UPDATE sessions SET last_activity_at = ?, ended_at = NULL WHERE project_id = ? AND harness_session_id = ?")
        .bind(at, project.id, sessionKey)
        .run();
      ctx.waitUntil(report(env, e, project, sessionKey, turnID, false));
      return {};
    }
    case "SessionEnd": {
      await db.batch([
        db
          .prepare(
            // Keep a turn's failure or interruption; ended_at independently records the session closing.
            `UPDATE turns SET state = CASE WHEN state IN ('working', 'idle') THEN 'ended' ELSE state END, last_activity_at = ?, ended_at = ?
             WHERE session_key = ? AND agent = ? AND machine = ? AND ended_at IS NULL AND last_activity_at <= ?`,
          )
          .bind(at, at, sessionKey, e.agent, e.machine, at),
        db
          .prepare("UPDATE sessions SET last_activity_at = ?, ended_at = ? WHERE project_id = ? AND harness_session_id = ?")
          .bind(at, at, project.id, sessionKey),
      ]);
      ctx.waitUntil(report(env, e, project, sessionKey, null, true));
      return {};
    }
    default:
      return {};
  }
}

export interface UpdateWork {
  repoURL: string;
  description: string;
  sessionKey: string;
  turnID: string;
  agentName: string;
  sessionID?: string | null;
}

/** Enriches the exact turn a hook captured. Never claims "the newest turn": several harnesses may share a repo. */
export async function updateWork(db: D1Database, input: UpdateWork): Promise<void> {
  const description = redact(input.description.trim());
  if (!description) throw new UserError("description must not be empty");
  const project = await ensureProject(db, input.repoURL);
  const turn = await db
    .prepare("SELECT id FROM turns WHERE project_id = ? AND agent = ? AND session_key = ? AND turn_id = ? ORDER BY started_at DESC LIMIT 1")
    .bind(project.id, input.agentName, input.sessionKey, input.turnID)
    .first<{ id: string }>();
  if (!turn) throw new UserError("No captured turn matches that sessionKey and turnID. Use the values from the turn-start hook.");
  const session = input.sessionID
    ? await db.prepare("SELECT id FROM sessions WHERE project_id = ? AND session_id = ?").bind(project.id, input.sessionID).first<{ id: number }>()
    : null;
  // A description is not a lifecycle event: it cannot resurrect or prolong a turn.
  await db
    .prepare("UPDATE turns SET description = ?, session_pk = COALESCE(?, session_pk) WHERE id = ?")
    .bind(description, session?.id ?? null, turn.id)
    .run();
}

/** Reads a hook POST: the harness payload as the JSON body, client facts as query parameters. */
export async function parseHookRequest(request: Request): Promise<HookEvent> {
  const url = new URL(request.url);
  const q = (name: string) => url.searchParams.get(name)?.trim() ?? "";
  let hook: unknown;
  try {
    hook = await request.json();
  } catch {
    throw new UserError("Body must be the hook's JSON payload");
  }
  if (!hook || typeof hook !== "object" || Array.isArray(hook)) throw new UserError("Body must be a JSON object");
  const payload = hook as Record<string, unknown>;
  const event = q("event") || text(payload.hook_event_name);
  if (!event) throw new UserError("event is required");
  const dirty = q("dirty");
  return {
    event,
    agent: (q("agent") || "claude").slice(0, 40),
    machine: q("machine").slice(0, 100),
    machineName: q("machineName").slice(0, 200) || null,
    repo: q("repo") || text(payload.cwd),
    uncommitted: dirty === "1" || dirty === "true" ? true : dirty === "0" || dirty === "false" ? false : null,
    turnID: q("turn").slice(0, 100) || null,
    at: parseTime(q("at")),
    hook: payload,
  };
}
