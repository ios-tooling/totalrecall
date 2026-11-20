// The review interface: a read-only look at everything stored, for a person signed in
// through Cloudflare Access.
//   GET /review                  the page
//   GET /review/api/me           who is signed in
//   GET /review/api/overview     counts and the newest activity
//   GET /review/api/projects     every project
//   GET /review/api/projects/:id one project: status, sessions, memories, recent turns
//   GET /review/api/sessions/:pk one session: its entries and turns
//   GET /review/api/turns        recent turns (?project=, ?before=, ?limit=)
//   GET /review/api/memories     memories (?state=active|retired|all)
//   GET /review/api/search       ranked search (?q=, ?project=)

import { accessConfigured, accessIdentity } from "../access";
import { searchProject } from "../search";
import { type AppEnv, json } from "../util";
import page from "./page.html";

const noStore = { "cache-control": "no-store" };

function data(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...noStore } });
}

function limitOf(url: URL, fallback: number, max: number): number {
  const value = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
  return Number.isFinite(value) && value > 0 ? Math.min(value, max) : fallback;
}

function idOf(text: string | null | undefined): number | null {
  const value = Number.parseInt(text ?? "", 10);
  return Number.isFinite(value) && value > 0 ? value : null;
}

const TURN_COLUMNS = `t.id, t.project_id, t.session_pk, t.agent, t.machine, t.machine_name, t.session_key, t.summary, t.prompt,
  t.description, t.folder_path, t.state, t.end_reason, t.uncommitted, t.started_at, t.last_activity_at, t.ended_at,
  p.display_name AS project, s.session_id AS session`;
const TURN_JOINS = "FROM turns t JOIN projects p ON p.id = t.project_id LEFT JOIN sessions s ON s.id = t.session_pk";

async function overview(db: D1Database): Promise<Response> {
  const counts = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM projects) AS projects, (SELECT COUNT(*) FROM sessions) AS sessions,
              (SELECT COUNT(*) FROM entries) AS entries, (SELECT COUNT(*) FROM turns) AS turns,
              (SELECT COUNT(*) FROM memories WHERE retired_at IS NULL) AS memories,
              (SELECT COUNT(*) FROM memories WHERE retired_at IS NOT NULL) AS retiredMemories`,
    )
    .first();
  const [turns, entries] = await db.batch([
    db.prepare(`SELECT ${TURN_COLUMNS} ${TURN_JOINS} ORDER BY t.last_activity_at DESC LIMIT 12`),
    db.prepare(
      `SELECT e.id, e.kind, e.title, e.content, e.created_at, e.session_pk, s.session_id AS session, s.agent, s.machine,
              e.project_id, p.display_name AS project
       FROM entries e JOIN sessions s ON s.id = e.session_pk JOIN projects p ON p.id = e.project_id
       WHERE e.kind <> 'attachment' ORDER BY e.id DESC LIMIT 12`,
    ),
  ]);
  return data({ counts, turns: turns!.results, entries: entries!.results });
}

async function projects(db: D1Database): Promise<Response> {
  const { results } = await db
    .prepare(
      `SELECT p.id, p.display_name, p.repo_url, p.created_at, p.status_updated_at,
              (SELECT COUNT(*) FROM sessions s WHERE s.project_id = p.id) AS sessions,
              (SELECT COUNT(*) FROM entries e WHERE e.project_id = p.id) AS entries,
              (SELECT COUNT(*) FROM turns t WHERE t.project_id = p.id) AS turns,
              (SELECT COUNT(*) FROM memories m WHERE m.project_id = p.id AND m.retired_at IS NULL) AS memories,
              max(COALESCE((SELECT MAX(last_activity_at) FROM sessions WHERE project_id = p.id), ''),
                  COALESCE((SELECT MAX(last_activity_at) FROM turns WHERE project_id = p.id), ''),
                  p.created_at) AS last_activity
       FROM projects p ORDER BY last_activity DESC`,
    )
    .all();
  return data({ projects: results });
}

async function project(db: D1Database, id: number): Promise<Response> {
  const row = await db.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!row) return data({ error: "No such project" }, 404);
  const [sessions, memories, turns] = await db.batch([
    db.prepare(
      `SELECT s.*, (SELECT COUNT(*) FROM entries e WHERE e.session_pk = s.id) AS entries
       FROM sessions s WHERE s.project_id = ? ORDER BY s.started_at DESC, s.id DESC LIMIT 200`,
    ).bind(id),
    db.prepare(
      `SELECT m.*, p.display_name AS project FROM memories m JOIN projects p ON p.id = m.project_id
       WHERE m.project_id = ? ORDER BY m.retired_at IS NOT NULL, m.id DESC LIMIT 500`,
    ).bind(id),
    db.prepare(`SELECT ${TURN_COLUMNS} ${TURN_JOINS} WHERE t.project_id = ? ORDER BY t.last_activity_at DESC LIMIT 50`).bind(id),
  ]);
  return data({ project: row, sessions: sessions!.results, memories: memories!.results, turns: turns!.results });
}

async function session(db: D1Database, pk: number): Promise<Response> {
  const row = await db
    .prepare("SELECT s.*, p.display_name AS project, p.repo_url FROM sessions s JOIN projects p ON p.id = s.project_id WHERE s.id = ?")
    .bind(pk)
    .first();
  if (!row) return data({ error: "No such session" }, 404);
  const [entries, turns] = await db.batch([
    db.prepare("SELECT id, kind, title, content, commits, created_at FROM entries WHERE session_pk = ? ORDER BY id LIMIT 1000").bind(pk),
    db.prepare(`SELECT ${TURN_COLUMNS} ${TURN_JOINS} WHERE t.session_pk = ? ORDER BY t.started_at LIMIT 500`).bind(pk),
  ]);
  return data({ session: row, entries: entries!.results, turns: turns!.results });
}

async function turns(db: D1Database, url: URL): Promise<Response> {
  const projectID = idOf(url.searchParams.get("project"));
  const before = url.searchParams.get("before") || "9999";
  const { results } = await db
    .prepare(
      `SELECT ${TURN_COLUMNS} ${TURN_JOINS}
       WHERE t.last_activity_at < ?1 AND (?2 IS NULL OR t.project_id = ?2) ORDER BY t.last_activity_at DESC LIMIT ?3`,
    )
    .bind(before, projectID, limitOf(url, 50, 200))
    .all();
  return data({ turns: results });
}

async function memories(db: D1Database, url: URL): Promise<Response> {
  const state = url.searchParams.get("state") ?? "active";
  const filter = state === "all" ? "1 = 1" : state === "retired" ? "m.retired_at IS NOT NULL" : "m.retired_at IS NULL";
  const { results } = await db
    .prepare(
      `SELECT m.*, p.display_name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE ${filter} ORDER BY m.id DESC LIMIT 1000`,
    )
    .all();
  return data({ memories: results });
}

async function api(db: D1Database, path: string, url: URL, email: string): Promise<Response> {
  const [resource, id] = path.split("/");
  switch (resource) {
    case "me":
      return data({ email });
    case "overview":
      return overview(db);
    case "projects": {
      if (id === undefined) return projects(db);
      const projectID = idOf(id);
      return projectID ? project(db, projectID) : data({ error: "No such project" }, 404);
    }
    case "sessions": {
      const pk = idOf(id);
      return pk ? session(db, pk) : data({ error: "No such session" }, 404);
    }
    case "turns":
      return turns(db, url);
    case "memories":
      return memories(db, url);
    case "search": {
      const query = url.searchParams.get("q") ?? "";
      return data({ query, hits: await searchProject(db, query, idOf(url.searchParams.get("project")), limitOf(url, 50, 100)) });
    }
    default:
      return data({ error: "Not found" }, 404);
  }
}

/** The page, with a fresh nonce: its one script and one style block run, and nothing else can. */
function html(): Response {
  const nonce = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(18))));
  return new Response(page.replaceAll("__NONCE__", nonce), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      ...noStore,
    },
  });
}

export async function handleReview(request: Request, env: AppEnv): Promise<Response> {
  // Closed until Access is configured, and to everyone Access has not signed in.
  if (!accessConfigured(env)) return json(404, { error: "The review interface is not enabled." });
  const identity = await accessIdentity(request, env);
  if (!identity) return json(403, { error: "Sign in through Cloudflare Access to review Total Recall." });
  if (request.method !== "GET") return json(405, { error: "The review interface is read-only." });

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/review\/?/, "");
  if (path === "") return html();
  if (path.startsWith("api/")) return api(env.DB, path.slice(4).replace(/\/+$/, ""), url, identity.email);
  return json(404, { error: "Not found" });
}
