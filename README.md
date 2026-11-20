# Total Recall

Shared work history and memory for coding agents, on every machine. One Cloudflare Worker with a D1 database; agents reach it over MCP, and Claude Code and Codex hooks feed it turn by turn.

It replaces AIHistoryKit's per-Mac MCP server (same tool names and parameters) and adds durable memories that are injected when a session starts.

## What it does

| Piece | What |
| --- | --- |
| `POST /mcp` | MCP over Streamable HTTP, bearer `AGENT_TOKEN`. Serves both current (2026-07-28) and 2025-era clients, statelessly. |
| `POST /v1/events` | Hook events from Claude Code and Codex, bearer `INGEST_TOKEN` (or `AGENT_TOKEN`). The hook's JSON payload is the body; what only the client knows (`event`, `agent`, `machine`, `machineName`, `repo`, `dirty`, `turn`, `at`) are query parameters. |
| `GET /` | Health. |
| `client/totalrecall-hook.sh` | The hook forwarder. Only `SessionStart` waits for the server; everything else is sent in the background. |

**Tools.** History, as in AIHistoryKit: `start_session`, `log_work`, `update_status`, `end_session`, `update_work`, `attach_file`, `get_project_context`, `list_sessions`, `search_history`, `get_activity`. Memory: `remember`, `recall`, `forget`. (`upload_app_store_build` stays in DevCenter; it needs a Mac.)

**What changed from AIHistoryKit**

- One store for every machine and surface, instead of files per Mac synced through CloudKit.
- `search_history` is ranked full-text search (SQLite FTS5, stemmed) over work entries, captured prompts and memories, not a substring scan that stops at 20 hits.
- Everything is redacted on write (`src/redact.ts`), so tokens and keys never reach the database. Full 40-character commit hashes in free text are masked too; pass them in `commits`, which is stored as given.
- `SessionStart` injects content: the open session id, the memories that apply, the project's status and its last five work entries. The rest is one tool call away.
- Hooks do not block the turn: the git working-tree check and the post both run in the background.
- `end_session` token counts are session totals; they no longer double what `log_work` recorded.
- `get_activity` covers every machine, and renders times in the UTC offset of its `since` argument.
- An unknown `sessionID` is an error the agent can read, not a silent write to nowhere.

**Memories** are one self-contained statement each, of kind `correction`, `decision`, `preference` or `fact`, either global or scoped to a repository. `remember` with `supersedes` retires the memory it replaces; `forget` retires one outright. Retired memories are kept but never recalled or searched.

**Chief of Staff.** When a turn stops or a session ends, the Worker posts the same `session` event DevCenter's reporter sent to `chief-of-staff-ingest` (`POST /events`), throttled per session to once every 30 minutes unless the session ended or its uncommitted flag changed. Chief of Staff's collector needs no change, and it stops depending on AIHistoryKit's local turn files.

## Layout

```
migrations/0001_init.sql   schema: projects, sessions, entries, turns, memories, search index
src/index.ts               router and auth
src/mcp.ts                 tool definitions
src/history.ts             sessions and append-only entries
src/turns.ts               hook events → turn lifecycle
src/context.ts             what SessionStart injects
src/memory.ts  search.ts  activity.ts  cos.ts  repo.ts  redact.ts  util.ts
client/totalrecall-hook.sh hook forwarder
test/                      runs inside the Workers runtime against a real local D1
```

## Develop

```bash
npm install
npm test            # vitest in the Workers runtime, migrations applied
npm run typecheck
```

To run it locally, put `AGENT_TOKEN=…` and `INGEST_TOKEN=…` in `.dev.vars`, then:

```bash
npm run migrate:local
npm run dev
```

## Deploy

The Worker runs at `https://total-recall.stream`, backed by the D1 database `totalrecall` (its id is in `wrangler.jsonc`). There is no `workers.dev` address.

To ship a change:

1. `npm run migrate:remote`, if `migrations/` has something new.
2. `npm run deploy`

Secrets are set once with `npx wrangler secret put <NAME>`:

| Secret | Purpose |
| --- | --- |
| `AGENT_TOKEN` | Bearer token for agents (`/mcp`, and `/v1/events`). |
| `INGEST_TOKEN` | Bearer token for hook scripts (`/v1/events` only). |
| `COS_INGEST_TOKEN` | Chief of Staff's ingest token. Forwarding also needs the `services` binding in `wrangler.jsonc` uncommented; without both, nothing is forwarded. |

To stand up a copy elsewhere: `npx wrangler d1 create <name>`, put the printed id and your own domain in `wrangler.jsonc`, then migrate, set the secrets and deploy.

## Connect a client

The Worker is deployed and answers MCP calls; the client setup below has not been run on a Mac yet.

**Hooks (Claude Code and Codex, on a Mac).** Copy `client/totalrecall-hook.sh` to `~/.local/bin/`, and create `~/.config/totalrecall/env` (mode 600):

```sh
TOTALRECALL_INGEST_TOKEN=…
```

The script posts to `https://total-recall.stream` unless `TOTALRECALL_URL` says otherwise.

Register it for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` and `SessionEnd` in `~/.claude/settings.json`, one entry per event:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "\"$HOME/.local/bin/totalrecall-hook.sh\" SessionStart" }] }] } }
```

For Codex, the same in `~/.codex/hooks.json` with `codex` as the second argument (`… totalrecall-hook.sh Stop codex`), for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt` and `SessionEnd`.

**MCP, Claude Code** (`~/.claude.json` or a repo's `.mcp.json`):

```json
{ "mcpServers": { "totalrecall": { "type": "http", "url": "https://total-recall.stream/mcp", "headers": { "Authorization": "Bearer ${TOTALRECALL_AGENT_TOKEN}" } } } }
```

**MCP, Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.totalrecall]
url = "https://total-recall.stream/mcp"
bearer_token_env_var = "TOTALRECALL_AGENT_TOKEN"
```

A client with no hooks can say where it runs with an `X-Totalrecall-Machine` header, or the `machine` argument of `start_session`.

## Not built yet

- **OAuth**, which the Claude web, desktop and mobile apps need to add this as a custom connector. Bearer tokens cover Claude Code, Codex and cloud sessions.
- **An offline spool** in the hook script: an event posted while the Worker is unreachable is lost.
- **Importing** existing AIHistoryKit history, and moving DevCenter's installer and apps over to this server.
- **Transcript ingestion** and semantic (embedding) search. Today the history is what agents log plus every captured prompt.
- **Token totals from transcripts.** AIHistoryKit's hooks summed usage from Claude's transcript file; here totals come only from `log_work` and `end_session`.
