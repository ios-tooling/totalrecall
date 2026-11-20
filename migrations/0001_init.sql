-- Total Recall: work history, turn capture and durable memories.
-- Every timestamp is ISO-8601 UTC text, so string order is time order.

-- One row per repository. identity_key folds URL spellings and case together.
CREATE TABLE projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  identity_key TEXT NOT NULL UNIQUE,
  repo_url TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT,
  status_updated_at TEXT,
  created_at TEXT NOT NULL
);

-- An agent's working session on a project. session_id is unique within its project.
CREATE TABLE sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  machine TEXT,
  model TEXT,
  harness_session_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  last_activity_at TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_tokens INTEGER NOT NULL DEFAULT 0,
  commits TEXT NOT NULL DEFAULT '[]',
  UNIQUE (project_id, session_id)
);
CREATE INDEX sessions_recent ON sessions (project_id, started_at DESC);
CREATE INDEX sessions_harness ON sessions (harness_session_id);

-- Append-only history. kind: work | summary | status | attachment.
CREATE TABLE entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_pk INTEGER NOT NULL REFERENCES sessions(id),
  kind TEXT NOT NULL,
  title TEXT,
  content TEXT NOT NULL,
  commits TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX entries_session ON entries (session_pk, id);
CREATE INDEX entries_project ON entries (project_id, id DESC);

-- One row per agent turn, captured by client hooks.
-- state: working | idle | ended | interrupted | failed.
CREATE TABLE turns (
  id TEXT PRIMARY KEY,
  project_id INTEGER NOT NULL REFERENCES projects(id),
  session_pk INTEGER REFERENCES sessions(id),
  agent TEXT NOT NULL,
  machine TEXT NOT NULL DEFAULT '',
  machine_name TEXT,
  session_key TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  summary TEXT NOT NULL DEFAULT '',
  prompt TEXT,
  description TEXT,
  folder_path TEXT,
  state TEXT NOT NULL,
  end_reason TEXT,
  uncommitted INTEGER,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX turns_session ON turns (session_key, last_activity_at DESC);
CREATE INDEX turns_recent ON turns (project_id, last_activity_at DESC);

-- Durable memories: things that should change how future sessions behave.
-- kind: correction | decision | preference | fact. project_id NULL means global.
CREATE TABLE memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER REFERENCES projects(id),
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT NOT NULL,
  retired_at TEXT,
  retired_reason TEXT,
  superseded_by INTEGER REFERENCES memories(id)
);
CREATE INDEX memories_active ON memories (project_id, kind) WHERE retired_at IS NULL;

-- Throttle for Chief of Staff session posts.
CREATE TABLE cos_posts (
  session_key TEXT PRIMARY KEY,
  posted_at TEXT NOT NULL,
  uncommitted INTEGER
);

-- Full-text index over everything searchable. source: entry | turn | memory.
CREATE VIRTUAL TABLE search_index USING fts5(
  body,
  source UNINDEXED,
  source_id UNINDEXED,
  project_id UNINDEXED,
  created_at UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TRIGGER entries_index AFTER INSERT ON entries BEGIN
  INSERT INTO search_index (body, source, source_id, project_id, created_at)
  VALUES (new.content, 'entry', new.id, new.project_id, new.created_at);
END;

CREATE TRIGGER turns_index AFTER INSERT ON turns WHEN new.prompt IS NOT NULL AND new.prompt <> '' BEGIN
  INSERT INTO search_index (body, source, source_id, project_id, created_at)
  VALUES (new.prompt, 'turn', new.id, new.project_id, new.started_at);
END;

CREATE TRIGGER turns_description_index AFTER UPDATE OF description ON turns
WHEN new.description IS NOT NULL AND new.description <> '' AND new.description IS NOT old.description BEGIN
  INSERT INTO search_index (body, source, source_id, project_id, created_at)
  VALUES (new.description, 'turn', new.id, new.project_id, new.last_activity_at);
END;

CREATE TRIGGER memories_index AFTER INSERT ON memories BEGIN
  INSERT INTO search_index (body, source, source_id, project_id, created_at)
  VALUES (new.content, 'memory', new.id, new.project_id, new.created_at);
END;
