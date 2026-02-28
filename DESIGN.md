# Design Decisions

## Architecture

```
Discord/Slack/Web UI
        ↓
  Bridge (Express + WS + Bots)
        ↓
  PiAgent (manages sessions)
        ↓
  AgentSession (pi SDK, one per conversation)
        ↓
  /workspace/<repo>-wt-<branch>/  (worktree per session)
```

---

## Decisions

### 1. GitHub auth
- **GitHub PAT** via `GITHUB_TOKEN` env var
- Agent can clone and push to any repo the token has access to
- Token scope managed by the user when creating the PAT
- Git config inside container: `url."https://${GITHUB_TOKEN}@github.com/".insteadOf "https://github.com/"`

### 2. Workspace structure — worktree-based
Multi-project, worktree-per-session:

```
/workspace/
  currico/                        ← main checkout (base, never worked on directly)
  currico-wt-fix-auth-a1b2c3/     ← worktree for session a1b2c3
  currico-wt-new-landing-d4e5f6/  ← worktree for session d4e5f6
  other-repo/                     ← another repo base
  other-repo-wt-refactor-g7h8i9/  ← worktree for that repo
```

#### Session startup flow
1. User starts conversation: "work on currico, fix the auth bug"
2. Agent clones `currico` to `/workspace/currico/` if not already there
3. Agent creates a new branch: `wt/fix-auth-<short-id>`
4. Agent creates worktree: `git worktree add /workspace/currico-wt-fix-auth-<id> wt/fix-auth-<id>`
5. Session `cwd` is set to the worktree directory
6. Agent works in that worktree

#### Worktree naming convention
```
/workspace/<repo>-wt-<description>-<session-short-id>/
```

### 3. Session lifecycle

```
New conversation
  → clone repo if needed
  → create branch + worktree
  → set session cwd to worktree
  → work (edits, tests, commits)
  → idle 24h OR evicted by LRU
  → commit any uncommitted changes
  → push branch
  → git worktree remove
  → session.dispose()
```

### 4. Session limits
- **Max concurrent sessions: 8**
- When 9th session starts, evict the **least recently used** idle session
- Eviction runs the full cleanup: commit → push → remove worktree → dispose
- If all 8 are actively streaming, the 9th request gets a "busy" error

### 5. Resuming old sessions
- **Start fresh** — don't try to resume from pi JSONL files
- **Inject thread context** — pull recent message history from Discord/Slack thread and include it as context in the first prompt
- The old branch is still on GitHub, agent can check it out or reference it
- Format:
  ```
  Previous conversation context from this thread:
  [user]: fix the auth bug on the login page
  [agent]: I'll look into the auth module...
  [user]: also check the session timeout
  ...

  New message: <current message>
  ```

### 6. Dev server
- **Not running for now** — agent edits code and runs tests, doesn't start the dev server
- Can be added later by exposing ports and running `next dev --hostname 0.0.0.0`

### 7. Testing
- **Vitest** — agent can run `npm run test` for unit tests
- **Playwright** — installed in container with Chromium, agent can run e2e tests
- Tests run against the worktree, not the main checkout

### 8. Container capabilities
Installed in Dockerfile:
- Node 22
- git, curl, jq, ripgrep, fd
- Python 3
- Playwright + Chromium

Not available:
- Docker socket (no Docker-in-Docker)
- Database (no Postgres in the agent container)
- Host filesystem access outside /workspace

### 9. Interfaces
All interfaces share the same PiAgent and session pool:
- **Discord bot** — threaded conversations, `!new` to reset
- **Slack bot** — Socket Mode, threaded conversations, `!new` to reset
- **Web UI** — chat + real-time activity monitor across all sessions
- **HTTP API** — REST endpoints for programmatic access

### 10. Deployment (Dokploy)
- Git push → Dokploy webhook → rebuild + restart
- `../files/workspace` persists across deploys (repos + worktrees)
- `pi-sessions` named volume for session JSONL files
- Env vars via Dokploy Environment tab
- Optional domain with auto-HTTPS

---

## Environment Variables

```env
# LLM provider
ANTHROPIC_API_KEY=sk-ant-...

# GitHub access (clone + push)
GITHUB_TOKEN=ghp_...

# Discord (optional)
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...

# Slack (optional)
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...

# Server
PORT=3000
WORKSPACE_DIR=/workspace
```

---

## Implementation TODO

- [ ] Add `GITHUB_TOKEN` git config to Dockerfile entrypoint
- [ ] Add Playwright + Chromium to Dockerfile
- [ ] Implement worktree manager (create, track, cleanup)
- [ ] Implement session lifecycle (idle tracking, LRU eviction, cleanup)
- [ ] Set session `cwd` to worktree directory on creation
- [ ] Implement thread context injection for resumed threads
- [ ] Add max session limit (8) with LRU eviction
- [ ] Update AGENTS.md with dev workflow instructions
- [ ] Update .env.example with GITHUB_TOKEN
- [ ] Test locally, then deploy to Dokploy
