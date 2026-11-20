// Cross-project digest of recent agent turns, grouped by repo and harness session, plus
// sessions that left uncommitted changes 1-14 days ago. Ported from AIHistoryKit's
// ActivityAggregator; the report shape is unchanged.

import { findProject } from "./history";
import type { Turn } from "./turns";
import { truncate } from "./util";

/** A `working` turn silent longer than this is an orphan, not a live agent. */
const RUNNING_WINDOW_MS = 60 * 60 * 1000;
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
const STALE_LIMIT_MS = 14 * 24 * 60 * 60 * 1000;

type Row = Turn & { repo_url: string; display_name: string; ai_session_id: string | null };

/** Renders times in the caller's UTC offset, taken from their `since`, e.g. `2026-11-06T09:00:00-06:00`. */
export function offsetFormatter(since: string): (isoTime: string) => string {
  const match = since.match(/([+-])(\d{2}):?(\d{2})$/);
  const minutes = match ? (match[1] === "-" ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3])) : 0;
  const suffix = match ? `${match[1]}${match[2]}:${match[3]}` : "Z";
  return (isoTime) => new Date(Date.parse(isoTime) + minutes * 60_000).toISOString().slice(0, 19) + suffix;
}

function summaryLine(turn: Row): string | null {
  const line = (turn.description?.trim() || turn.summary.trim()).split(/\r?\n/)[0]?.trim();
  return line ? truncate(line, 120) : null;
}

const newestFirst = (turns: Row[]) => [...turns].sort((a, b) => b.last_activity_at.localeCompare(a.last_activity_at));

function groupBy<T>(items: T[], key: (item: T) => string | number): T[][] {
  const groups = new Map<string | number, T[]>();
  for (const item of items) groups.set(key(item), [...(groups.get(key(item)) ?? []), item]);
  return [...groups.values()];
}

export async function activityReport(db: D1Database, input: { since: string; repoURL?: string | null; includePrompts?: boolean }, now = new Date()) {
  const sinceMs = Date.parse(input.since);
  if (Number.isNaN(sinceMs)) throw new Error("since must be an ISO-8601 timestamp");
  const since = new Date(sinceMs).toISOString();
  const format = offsetFormatter(input.since);
  const horizon = new Date(Math.min(sinceMs, now.getTime() - STALE_LIMIT_MS)).toISOString();

  let projectID: number | null = null;
  if (input.repoURL) {
    const project = await findProject(db, input.repoURL);
    if (!project) return { generatedAt: format(now.toISOString()), since: format(since), repos: [] };
    projectID = project.id;
  }
  const { results } = await db
    .prepare(
      `SELECT t.*, p.repo_url, p.display_name, s.session_id AS ai_session_id
       FROM turns t JOIN projects p ON p.id = t.project_id LEFT JOIN sessions s ON s.id = t.session_pk
       WHERE t.last_activity_at >= ?1 AND (?2 IS NULL OR t.project_id = ?2)
       ORDER BY t.last_activity_at DESC LIMIT 5000`,
    )
    .bind(horizon, projectID)
    .all<Row>();

  const repos = groupBy(results, (turn) => turn.project_id).map((turns) => {
    const window = turns.filter((turn) => turn.last_activity_at >= since);
    const sessions = groupBy(window, (turn) => turn.session_key)
      .map(newestFirst)
      .sort((a, b) => b[0]!.last_activity_at.localeCompare(a[0]!.last_activity_at));
    // Sessions whose newest turn left the checkout dirty between a day and two weeks ago.
    const stale = groupBy(turns, (turn) => turn.session_key)
      .map((group) => newestFirst(group)[0]!)
      .filter((turn) => {
        const age = now.getTime() - Date.parse(turn.last_activity_at);
        return turn.uncommitted === 1 && age > STALE_AFTER_MS && age <= STALE_LIMIT_MS;
      });
    const newest = newestFirst(window)[0] ?? stale[0];
    if (!newest) return null;
    return {
      hasTurns: window.length > 0,
      sortKey: newest.last_activity_at,
      repo: {
        repoURL: newest.repo_url,
        repositoryName: newest.display_name,
        turns: window.length,
        lastActivity: format(newest.last_activity_at),
        sessions: sessions.map((group) => {
          const latest = group[0]!;
          const running = latest.state === "working" && now.getTime() - Date.parse(latest.last_activity_at) <= RUNNING_WINDOW_MS;
          const prompts = group.map((turn) => turn.prompt?.trim()).filter((p): p is string => !!p).slice(0, 3);
          return {
            sessionKey: latest.session_key,
            aiSessionID: latest.ai_session_id,
            agent: latest.agent,
            machine: latest.machine_name?.trim() || latest.machine,
            folder: latest.folder_path ?? "",
            state: latest.state === "working" && !running ? "idle" : latest.state,
            running,
            turns: group.length,
            startedAt: format(group.map((turn) => turn.started_at).sort()[0]!),
            lastActivity: format(latest.last_activity_at),
            uncommitted: latest.uncommitted === 1,
            summaries: group.map(summaryLine).filter((line): line is string => !!line).slice(0, 3),
            ...(input.includePrompts ? { prompts: prompts.map((prompt) => truncate(prompt, 2000)) } : {}),
          };
        }),
        staleUncommitted: stale.map((turn) => ({ sessionKey: turn.session_key, lastActivity: format(turn.last_activity_at) })),
      },
    };
  });

  // Repos with in-window turns first, newest first; stale-only repos after.
  const sorted = repos
    .filter((repo): repo is NonNullable<typeof repo> => repo !== null)
    .sort((a, b) => (a.hasTurns !== b.hasTurns ? (a.hasTurns ? -1 : 1) : b.sortKey.localeCompare(a.sortKey)));
  return { generatedAt: format(now.toISOString()), since: format(since), repos: sorted.map((entry) => entry.repo) };
}
