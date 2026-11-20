// Ranked full-text search over history entries, turn prompts and memories.

import { findProject } from "./history";

export interface SearchHit {
  source: "entry" | "turn" | "memory";
  /** The matched row's id: an entry or memory number, or a turn id. */
  id: string | number;
  projectID: number | null;
  project: string | null;
  sessionPK: number | null;
  session: string | null;
  kind: string | null;
  at: string;
  snippet: string;
}

/** FTS5 syntax is easy to break with punctuation, so every word becomes a quoted term. */
export function ftsQuery(query: string, joiner: "AND" | "OR"): string | null {
  const words = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  if (!words.length) return null;
  return words.slice(0, 16).map((word) => `"${word}"`).join(` ${joiner} `);
}

async function run(db: D1Database, match: string, projectID: number | null, limit: number): Promise<SearchHit[]> {
  const scope = projectID === null ? "" : "AND (search_index.project_id = ?2 OR search_index.project_id IS NULL)";
  const statement = db.prepare(
    `SELECT search_index.source AS source, search_index.source_id AS id, search_index.created_at AS at,
            snippet(search_index, 0, '«', '»', ' … ', 40) AS snippet,
            search_index.project_id AS projectID, p.display_name AS project,
            COALESCE(es.id, ts.id) AS sessionPK,
            COALESCE(es.session_id, ts.session_id) AS session,
            COALESCE(e.kind, m.kind) AS kind
     FROM search_index
     LEFT JOIN projects p ON p.id = search_index.project_id
     LEFT JOIN entries e ON search_index.source = 'entry' AND e.id = search_index.source_id
     LEFT JOIN sessions es ON es.id = e.session_pk
     LEFT JOIN turns t ON search_index.source = 'turn' AND t.id = search_index.source_id
     LEFT JOIN sessions ts ON ts.id = t.session_pk
     LEFT JOIN memories m ON search_index.source = 'memory' AND m.id = search_index.source_id
     WHERE search_index MATCH ?1 ${scope}
       AND (search_index.source <> 'memory' OR m.retired_at IS NULL)
     ORDER BY rank LIMIT ?3`,
  );
  const { results } = await statement.bind(match, projectID, limit).all<SearchHit>();
  return results;
}

export async function search(db: D1Database, query: string, repoURL?: string | null, limit = 20): Promise<SearchHit[]> {
  if (!repoURL) return searchProject(db, query, null, limit);
  const project = await findProject(db, repoURL);
  return project ? searchProject(db, query, project.id, limit) : [];
}

/** All words first; any word if that finds nothing. A project's search includes global memories. */
export async function searchProject(db: D1Database, query: string, projectID: number | null, limit = 20): Promise<SearchHit[]> {
  const strict = ftsQuery(query, "AND");
  if (!strict) return [];
  const hits = await run(db, strict, projectID, limit);
  if (hits.length) return hits;
  return run(db, ftsQuery(query, "OR")!, projectID, limit);
}

export function formatHits(hits: SearchHit[]): string {
  if (!hits.length) return "No matches.";
  return hits
    .map((hit) => {
      const where = [hit.project ?? "global", hit.session, hit.source === "entry" ? hit.kind : hit.source].filter(Boolean).join(" / ");
      return `[${where}] ${hit.at.slice(0, 10)}\n${hit.snippet}`;
    })
    .join("\n\n");
}
