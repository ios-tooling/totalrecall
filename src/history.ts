// Projects, sessions and their append-only history entries.

import { canonicalURL, displayName, identityKey } from "./repo";
import { redact } from "./redact";
import { UserError, iso, parseList, truncate } from "./util";

export interface Project {
  id: number;
  identity_key: string;
  repo_url: string;
  display_name: string;
  status: string | null;
  status_updated_at: string | null;
}

export interface Session {
  id: number;
  project_id: number;
  session_id: string;
  agent: string;
  machine: string | null;
  model: string | null;
  harness_session_id: string | null;
  started_at: string;
  ended_at: string | null;
  last_activity_at: string;
  input_tokens: number;
  output_tokens: number;
  cache_tokens: number;
  commits: string;
}

export interface Tokens {
  input?: number;
  output?: number;
  cache?: number;
}

/** Attachments and entries share D1's 2 MB row limit; stay well under it. */
const MAX_CONTENT = 1_000_000;

export async function findProject(db: D1Database, repoURL: string): Promise<Project | null> {
  return db.prepare("SELECT * FROM projects WHERE identity_key = ?").bind(identityKey(repoURL)).first<Project>();
}

export async function ensureProject(db: D1Database, repoURL: string, at = new Date()): Promise<Project> {
  if (!repoURL.trim()) throw new UserError("repoURL is required");
  const key = identityKey(repoURL);
  if (!key) throw new UserError(`repoURL "${repoURL}" does not name a repository`);
  await db
    .prepare(
      "INSERT INTO projects (identity_key, repo_url, display_name, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (identity_key) DO NOTHING",
    )
    .bind(key, canonicalURL(repoURL), displayName(repoURL), iso(at))
    .run();
  return (await findProject(db, repoURL))!;
}

/** `2026-07-30T00-24_codex`: the start minute (UTC) and the agent. */
export function sessionIDFor(agent: string, at: Date): string {
  const safeAgent = agent.trim().replace(/[^A-Za-z0-9._-]+/g, "-") || "agent";
  return `${iso(at).slice(0, 16).replace(":", "-")}_${safeAgent}`;
}

export interface StartSession {
  repoURL: string;
  agent: string;
  model?: string | null;
  machine?: string | null;
  harnessSessionID?: string | null;
  at?: Date;
}

/** Opens a session. A harness session that already has one gets it back, so a retried hook cannot open two. */
export async function startSession(db: D1Database, input: StartSession): Promise<{ project: Project; session: Session }> {
  const at = input.at ?? new Date();
  const project = await ensureProject(db, input.repoURL, at);
  if (input.harnessSessionID) {
    const existing = await db
      .prepare("SELECT * FROM sessions WHERE project_id = ? AND harness_session_id = ? ORDER BY id DESC LIMIT 1")
      .bind(project.id, input.harnessSessionID)
      .first<Session>();
    if (existing) return { project, session: existing };
  }
  const base = sessionIDFor(input.agent, at);
  for (let attempt = 1; attempt <= 20; attempt++) {
    const sessionID = attempt === 1 ? base : `${base}-${attempt}`;
    const result = await db
      .prepare(
        `INSERT INTO sessions (project_id, session_id, agent, machine, model, harness_session_id, started_at, last_activity_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (project_id, session_id) DO NOTHING`,
      )
      .bind(project.id, sessionID, input.agent, input.machine ?? null, input.model ?? null, input.harnessSessionID ?? null, iso(at), iso(at))
      .run();
    if (result.meta.changes > 0) return { project, session: (await findSession(db, project.id, sessionID))! };
  }
  throw new Error("could not allocate a session id");
}

export async function findSession(db: D1Database, projectID: number, sessionID: string): Promise<Session | null> {
  return db.prepare("SELECT * FROM sessions WHERE project_id = ? AND session_id = ?").bind(projectID, sessionID).first<Session>();
}

async function requireSession(db: D1Database, repoURL: string, sessionID: string): Promise<{ project: Project; session: Session }> {
  const project = await findProject(db, repoURL);
  const session = project ? await findSession(db, project.id, sessionID) : null;
  if (!project || !session) {
    throw new UserError(`No session "${sessionID}" for ${canonicalURL(repoURL)}. Call start_session first and use the sessionID it returns.`);
  }
  return { project, session };
}

function checkContent(content: string, what: string): string {
  if (!content.trim()) throw new UserError(`${what} must not be empty`);
  if (content.length > MAX_CONTENT) throw new UserError(`${what} is over ${MAX_CONTENT} characters`);
  return redact(content);
}

interface Append {
  repoURL: string;
  sessionID: string;
  content: string;
  kind: "work" | "summary" | "status" | "attachment";
  title?: string;
  tokens?: Tokens;
  commits?: string[];
  at?: Date;
}

/** Appends one entry and bumps the session's activity, tokens and commits. */
async function append(db: D1Database, input: Append): Promise<{ project: Project; session: Session }> {
  const at = iso(input.at ?? new Date());
  const { project, session } = await requireSession(db, input.repoURL, input.sessionID);
  const content = checkContent(input.content, input.kind === "attachment" ? "File content" : "content");
  const commits = [...new Set(input.commits ?? [])];
  const allCommits = [...new Set([...parseList(session.commits), ...commits])];
  const statements = [
    db
      .prepare("INSERT INTO entries (project_id, session_pk, kind, title, content, commits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(project.id, session.id, input.kind, input.title ?? null, content, JSON.stringify(commits), at),
    db
      .prepare(
        `UPDATE sessions SET last_activity_at = ?, input_tokens = input_tokens + ?, output_tokens = output_tokens + ?,
         cache_tokens = cache_tokens + ?, commits = ? WHERE id = ?`,
      )
      .bind(at, input.tokens?.input ?? 0, input.tokens?.output ?? 0, input.tokens?.cache ?? 0, JSON.stringify(allCommits), session.id),
  ];
  if (input.kind === "status") {
    statements.push(db.prepare("UPDATE projects SET status = ?, status_updated_at = ? WHERE id = ?").bind(content, at, project.id));
  }
  await db.batch(statements);
  return { project, session };
}

export function logWork(db: D1Database, input: Omit<Append, "kind" | "title">) {
  return append(db, { ...input, kind: "work" });
}

export function updateStatus(db: D1Database, input: Pick<Append, "repoURL" | "sessionID" | "content" | "at">) {
  return append(db, { ...input, kind: "status" });
}

export function attachFile(db: D1Database, input: Pick<Append, "repoURL" | "sessionID" | "content" | "at"> & { filename: string }) {
  const filename = input.filename.trim();
  if (!filename || filename.length > 200) throw new UserError("filename must be 1 to 200 characters");
  return append(db, { ...input, kind: "attachment", title: filename });
}

/** Records the summary and closes the session. Token counts here are session totals, not deltas. */
export async function endSession(db: D1Database, input: Omit<Append, "kind" | "title">): Promise<void> {
  const at = iso(input.at ?? new Date());
  const { session } = await append(db, { ...input, kind: "summary", tokens: undefined });
  const total = input.tokens ?? {};
  await db
    .prepare(
      `UPDATE sessions SET ended_at = ?, last_activity_at = ?, input_tokens = max(input_tokens, ?),
       output_tokens = max(output_tokens, ?), cache_tokens = max(cache_tokens, ?) WHERE id = ?`,
    )
    .bind(at, at, total.input ?? 0, total.output ?? 0, total.cache ?? 0, session.id)
    .run();
}

export async function listSessions(db: D1Database, repoURL: string, limit = 50): Promise<Session[]> {
  const project = await findProject(db, repoURL);
  if (!project) return [];
  const { results } = await db
    .prepare("SELECT * FROM sessions WHERE project_id = ? ORDER BY started_at DESC, id DESC LIMIT ?")
    .bind(project.id, limit)
    .all<Session>();
  return results;
}

interface EntryRow {
  kind: string;
  title: string | null;
  content: string;
  commits: string;
  created_at: string;
}

function formatEntry(entry: EntryRow): string {
  const when = entry.created_at.slice(0, 16).replace("T", " ") + " UTC";
  const commits = parseList(entry.commits);
  const tail = commits.length ? `\n\n*Commits: ${commits.join(", ")}*` : "";
  return `### ${when}${entry.kind === "summary" ? " (session summary)" : ""}\n\n${entry.content}${tail}`;
}

/** The newest entries of a session, oldest first, trimmed to a character budget. */
export async function sessionHistory(db: D1Database, sessionPK: number, budget: number, maxEntries = 12): Promise<string> {
  const { results } = await db
    .prepare("SELECT kind, title, content, commits, created_at FROM entries WHERE session_pk = ? AND kind IN ('work', 'summary') ORDER BY id DESC LIMIT ?")
    .bind(sessionPK, maxEntries)
    .all<EntryRow>();
  const kept: string[] = [];
  let used = 0;
  for (const entry of results) {
    const text = truncate(formatEntry(entry), Math.max(400, budget - used));
    kept.unshift(text);
    used += text.length;
    if (used >= budget) break;
  }
  return kept.join("\n\n---\n\n");
}

/** Status plus the three most recent sessions' history: what `get_project_context` returns. */
export async function projectContext(db: D1Database, repoURL: string, budget = 24_000): Promise<string> {
  const project = await findProject(db, repoURL);
  if (!project) return "No history yet.";
  const parts: string[] = [];
  if (project.status) parts.push(`## Current Status\n\n${truncate(project.status, 6000)}`);
  const sessions = (await listSessions(db, repoURL, 3)).filter(Boolean);
  const perSession = Math.floor((budget - (project.status?.length ?? 0)) / 3);
  const histories: string[] = [];
  for (const session of sessions) {
    const history = await sessionHistory(db, session.id, Math.max(2000, perSession));
    if (history) histories.push(`### Session: ${session.session_id} (${session.agent}${session.machine ? `, ${session.machine}` : ""})\n\n${history}`);
  }
  if (histories.length) parts.push("## Recent Sessions", ...histories);
  return parts.length ? parts.join("\n\n") : "No history yet.";
}
