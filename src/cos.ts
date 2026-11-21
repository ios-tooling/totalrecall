// Forwards session snapshots to Chief of Staff's ingest Worker (`POST /events`), in the
// shape DevCenter's reporter used, so its collector keeps working once AIHistoryKit's
// local turn files are gone.

import type { Project } from "./history";
import { repoSlug } from "./repo";
import type { Turn } from "./turns";
import { type AppEnv, truncate } from "./util";

/** A session is re-posted at most this often unless it ended or its dirty flag changed. */
const POST_INTERVAL_MS = 30 * 60 * 1000;

export function cosBody(turn: Turn, project: Project, at: Date) {
  const stamp = at.toISOString().replace(/\.\d{3}Z$/, "Z");
  return {
    source: "hook",
    kind: "session",
    repo: repoSlug(project.repo_url),
    machine: turn.machine,
    at: stamp,
    dedupe: `hook:${turn.session_key}:${stamp}`,
    payload: {
      repoURL: project.repo_url,
      machineID: turn.machine || null,
      machineName: turn.machine_name,
      agentName: turn.agent,
      sessionKey: turn.session_key,
      summary: truncate(turn.summary, 200),
      hasUncommittedChanges: turn.uncommitted === null ? null : turn.uncommitted === 1,
      state: turn.state,
      folderPath: turn.folder_path,
    },
  };
}

/** Forwarding needs somewhere to send to and a token to send with. */
export const forwardingConfigured = (env: AppEnv) => !!(env.COS || env.COS_URL) && !!env.COS_INGEST_TOKEN?.trim();

export async function reportToChiefOfStaff(env: AppEnv, turn: Turn, project: Project, sessionEnded: boolean, at: Date): Promise<void> {
  if (!(env.COS || env.COS_URL)) return;
  const token = env.COS_INGEST_TOKEN?.trim();
  if (!token) {
    // A destination with no token is a half-finished setup, not a choice; say so where it can be found.
    console.warn("chief of staff: COS_INGEST_TOKEN is empty, so nothing is forwarded");
    return;
  }
  const last = await env.DB.prepare("SELECT posted_at, uncommitted FROM cos_posts WHERE session_key = ?")
    .bind(turn.session_key)
    .first<{ posted_at: string; uncommitted: number | null }>();
  const due =
    !last ||
    sessionEnded ||
    turn.state === "ended" ||
    at.getTime() - Date.parse(last.posted_at) >= POST_INTERVAL_MS ||
    last.uncommitted !== turn.uncommitted;
  if (!due) return;

  const init = {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(cosBody(turn, project, at)),
  };
  const response = env.COS
    ? await env.COS.fetch("https://chief-of-staff/events", init)
    : await fetch(`${env.COS_URL!.replace(/\/+$/, "")}/events`, init);
  if (!response.ok) {
    console.error(`chief of staff post failed: ${response.status}`);
    return;
  }
  await env.DB.prepare(
    "INSERT INTO cos_posts (session_key, posted_at, uncommitted) VALUES (?, ?, ?) ON CONFLICT (session_key) DO UPDATE SET posted_at = excluded.posted_at, uncommitted = excluded.uncommitted",
  )
    .bind(turn.session_key, at.toISOString(), turn.uncommitted)
    .run();
}
