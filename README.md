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

1. `npx wrangler d1 create totalrecall`, then paste the printed `database_id` into `wrangler.jsonc`.
2. `npm run migrate:remote`
3. `npx wrangler secret put AGENT_TOKEN`, then the same for `INGEST_TOKEN` (two different long random strings).
4. `npm run deploy`, then add the custom domain to the Worker in the Cloudflare dashboard (or a `routes` entry in `wrangler.jsonc`).
5. Chief of Staff forwarding (optional): uncomment the `services` binding in `wrangler.jsonc`, `npx wrangler secret put COS_INGEST_TOKEN` with Chief of Staff's ingest token, and deploy again. Without both, nothing is forwarded.

## Connect a client

None of this section has been run against a deployed Worker yet.

**Hooks (Claude Code and Codex, on a Mac).** Copy `client/totalrecall-hook.sh` to `~/.local/bin/`, and create `~/.config/totalrecall/env` (mode 600):

```sh
TOTALRECALL_URL=https://recall.example.com
TOTALRECALL_INGEST_TOKEN=…
```

Register it for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Stop`, `StopFailure` and `SessionEnd` in `~/.claude/settings.json`, one entry per event:

```json
{ "hooks": { "SessionStart": [{ "hooks": [{ "type": "command", "command": "\"$HOME/.local/bin/totalrecall-hook.sh\" SessionStart" }] }] } }
```

For Codex, the same in `~/.codex/hooks.json` with `codex` as the second argument (`… totalrecall-hook.sh Stop codex`), for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt` and `SessionEnd`.

**MCP, Claude Code** (`~/.claude.json` or a repo's `.mcp.json`):

```json
{ "mcpServers": { "totalrecall": { "type": "http", "url": "https://recall.example.com/mcp", "headers": { "Authorization": "Bearer ${TOTALRECALL_AGENT_TOKEN}" } } } }
```

**MCP, Codex** (`~/.codex/config.toml`):

```toml
[mcp_servers.totalrecall]
url = "https://recall.example.com/mcp"
bearer_token_env_var = "TOTALRECALL_AGENT_TOKEN"
```

A client with no hooks can say where it runs with an `X-Totalrecall-Machine` header, or the `machine` argument of `start_session`.

## Not built yet

- **OAuth**, which the Claude web, desktop and mobile apps need to add this as a custom connector. Bearer tokens cover Claude Code, Codex and cloud sessions.
- **An offline spool** in the hook script: an event posted while the Worker is unreachable is lost.
- **Importing** existing AIHistoryKit history, and moving DevCenter's installer and apps over to this server.
- **Transcript ingestion** and semantic (embedding) search. Today the history is what agents log plus every captured prompt.
- **Token totals from transcripts.** AIHistoryKit's hooks summed usage from Claude's transcript file; here totals come only from `log_work` and `end_session`.
