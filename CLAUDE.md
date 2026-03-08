# CLAUDE.md

## Build & Run

```bash
docker compose up --build -d      # build and start
docker compose logs -f             # tail logs
docker compose down                # stop
npm run dev                        # local dev (no Docker)
```

## LLM Authentication

The agent uses `auth.json` at `/root/.pi/agent/` inside the container, persisted via the `pi-agent-config` Docker volume.

### Setup (Option D — interactive login, recommended)

1. On your **local machine**, run `pi` then `/login anthropic` to authenticate
2. Copy your local `~/.pi/agent/auth.json` into the running container:

**Via Dokploy Terminal** (Services → pi-agent → Terminal):
```bash
cat > /root/.pi/agent/auth.json << 'EOF'
<paste contents of your local ~/.pi/agent/auth.json here>
EOF
```

**Via docker cp** (if you have SSH access to the server):
```bash
docker cp ~/.pi/agent/auth.json pi-remote-agent:/root/.pi/agent/auth.json
```

3. Restart the container — the entrypoint detects the existing `auth.json` and skips env var seeding
4. Pi handles token refresh automatically; refreshed tokens persist on the volume across restarts

### When tokens expire

If you see `Authentication failed for "anthropic"` errors:
1. Re-run `pi` → `/login anthropic` locally
2. Repeat the copy step above
3. Restart the container

### Alternative: API key (no expiry)

Set `ANTHROPIC_API_KEY=sk-ant-...` in the Dokploy environment variables. No manual auth needed, but uses API billing instead of your Claude subscription.

## Project Structure

```
src/
  index.ts          # Entrypoint — loads env, starts API + bots
  pi-agent.ts       # Core agent — session lifecycle, AuthStorage, ModelRegistry
  discord-bot.ts    # Discord bridge
  slack-bot.ts      # Slack bridge
  api.ts            # Express HTTP API + WebSocket
  worktree-manager.ts  # Git clone/worktree isolation
  session-manager.ts   # Session lifecycle (idle timeout, eviction)
entrypoint.sh       # Docker entrypoint — git config + auth.json seeding
docker-compose.yml  # Production compose (Dokploy)
```

## Key Dependency

`@mariozechner/pi-coding-agent` (latest) — provides `AuthStorage`, `ModelRegistry`, `createAgentSession`, `createCodingTools`. Auth is read from `~/.pi/agent/auth.json` automatically.

## Conventions

- TypeScript, ES modules (`"type": "module"`)
- Conventional commits: `feat:`, `fix:`, `docs:`, etc.
- Express 5 for HTTP, `ws` for WebSocket
- Per-thread sessions with worktree isolation for git repos
