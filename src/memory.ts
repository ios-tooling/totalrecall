// Durable memories: a small, curated set of things that should change how future
// sessions behave. Global (no project) or scoped to one repository.

import { ensureProject, findProject } from "./history";
import { redact } from "./redact";
import { UserError, iso, truncate } from "./util";

export const MEMORY_KINDS = ["correction", "decision", "preference", "fact"] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Memory {
  id: number;
  project_id: number | null;
  kind: MemoryKind;
  content: string;
  source: string | null;
  created_at: string;
  retired_at: string | null;
  project?: string | null;
}

const MAX_MEMORY = 2000;

export interface Remember {
  content: string;
  kind: MemoryKind;
  repoURL?: string | null;
  supersedes?: number | null;
  source?: string | null;
  at?: Date;
}

/** Stores a memory; `supersedes` retires the one it replaces so stale advice stops being recalled. */
export async function remember(db: D1Database, input: Remember): Promise<number> {
  const content = redact(input.content.trim());
  if (!content) throw new UserError("content must not be empty");
  if (content.length > MAX_MEMORY) throw new UserError(`A memory is at most ${MAX_MEMORY} characters; record longer material with log_work`);
  const at = iso(input.at ?? new Date());
  const project = input.repoURL ? await ensureProject(db, input.repoURL) : null;
  if (input.supersedes != null) {
    const old = await db.prepare("SELECT id FROM memories WHERE id = ? AND retired_at IS NULL").bind(input.supersedes).first();
    if (!old) throw new UserError(`No active memory with id ${input.supersedes}`);
  }
  const inserted = await db
    .prepare("INSERT INTO memories (project_id, kind, content, source, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(project?.id ?? null, input.kind, content, input.source ?? null, at)
    .run();
  const id = inserted.meta.last_row_id;
  if (input.supersedes != null) {
    await db
      .prepare("UPDATE memories SET retired_at = ?, retired_reason = 'superseded', superseded_by = ? WHERE id = ?")
      .bind(at, id, input.supersedes)
      .run();
  }
  return id;
}

export async function forget(db: D1Database, id: number, reason?: string | null, at = new Date()): Promise<void> {
  const result = await db
    .prepare("UPDATE memories SET retired_at = ?, retired_reason = ? WHERE id = ? AND retired_at IS NULL")
    .bind(iso(at), reason ?? "forgotten", id)
    .run();
  if (result.meta.changes === 0) throw new UserError(`No active memory with id ${id}`);
}

/** Active memories that apply to a repository: its own plus the global ones. Corrections first, newest first. */
export async function activeMemories(db: D1Database, repoURL?: string | null, limit = 200): Promise<Memory[]> {
  const project = repoURL ? await findProject(db, repoURL) : null;
  const { results } = await db
    .prepare(
      `SELECT m.*, p.display_name AS project FROM memories m LEFT JOIN projects p ON p.id = m.project_id
       WHERE m.retired_at IS NULL AND (m.project_id IS NULL OR m.project_id = ?1 OR ?2 = 1)
       ORDER BY CASE m.kind WHEN 'correction' THEN 0 WHEN 'decision' THEN 1 WHEN 'preference' THEN 2 ELSE 3 END, m.id DESC
       LIMIT ?3`,
    )
    .bind(project?.id ?? null, repoURL ? 0 : 1, limit)
    .all<Memory>();
  return results;
}

export function formatMemories(memories: Memory[], budget = Infinity): string {
  const lines: string[] = [];
  let used = 0;
  for (const memory of memories) {
    const scope = memory.project_id === null ? "global" : memory.project ?? "project";
    const line = `- #${memory.id} [${memory.kind}, ${scope}] ${truncate(memory.content.replace(/\s+/g, " "), 400)}`;
    if (used + line.length > budget) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines.join("\n");
}
