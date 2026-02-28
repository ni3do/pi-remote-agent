# pi-remote-agent

Run a [pi coding agent](https://github.com/badlogic/pi-mono) on your server and talk to it remotely via **Discord**, **Slack**, or **HTTP API**. Runs in Docker.

## Architecture

```
Discord/Slack → Bridge (Express + Bots) → Pi SDK (AgentSession) → Your Workspace
                                        ↕
                                   HTTP API (:3000)
```

- **One Pi agent process** handles all interfaces
- **Per-thread sessions** — each Discord/Slack thread gets its own conversation with full history
- **Docker volume mount** — pi reads/writes your actual project files
- **Sessions persist** across container restarts

## Quick Start

### 1. Clone and configure

```bash
cd pi-remote-agent
cp .env.example .env
# Edit .env with your API keys
```

### 2. Add your project

Put your project files in `./workspace/` (or change the volume mount in `docker-compose.yml`):

```bash
# Option A: clone a repo
git clone https://github.com/you/your-project workspace

# Option B: symlink an existing project
ln -s /path/to/your/project workspace
```

### 3. Run

```bash
docker compose up -d
```

That's it. The agent is now accessible via whichever interfaces you configured.

## Interfaces

### Web Chat UI

Open `http://your-server:3000` in your browser. No setup needed — it's always available.

**Features:**
- **Chat** with the pi agent in real-time (streamed responses via WebSocket)
- **Monitor all activity** across Discord, Slack, API, and web sessions in one place
- **Multiple sessions** — create and switch between independent conversations
- **Live sidebar** — see tool calls and agent activity as they happen
- **Tool call details** — see arguments, results, and errors inline with expandable output
- **Activity log** — timestamped log of every event across all threads and sources

The UI has two tabs:
- **💬 Chat** — talk to the agent directly
- **📊 All Activity** — real-time log of everything happening across all interfaces (Discord, Slack, API, web)

### Discord Bot

1. Create a bot at https://discord.com/developers/applications
2. Enable **Message Content Intent** under Bot settings
3. Add bot to your server with permissions: Send Messages, Read Message History, Read Messages
4. Set `DISCORD_BOT_TOKEN` in `.env`
5. Optionally set `DISCORD_CHANNEL_ID` to restrict to one channel

**Usage:**
- Mention the bot: `@pi-agent list all TypeScript files in src/`
- DM the bot directly
- `!new` — start a fresh session
- `!status` — check if the agent is running

### Slack Bot

1. Create an app at https://api.slack.com/apps
2. Enable **Socket Mode** (no public URL needed)
3. Add Bot Token Scopes: `app_mentions:read`, `chat:write`, `im:history`, `im:read`
4. Subscribe to events: `app_mention`, `message.im`
5. Set `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_SIGNING_SECRET` in `.env`

**Usage:**
- Mention the bot in a channel: `@pi-agent refactor the auth module`
- DM the bot directly
- `!new` — start a fresh session

### HTTP API

Always available on port 3000.

```bash
# Chat
curl -X POST http://your-server:3000/api/chat \
  -H "Content-Type: application/json" \
  -d '{"threadId": "my-session", "message": "List all files in src/"}'

# New session
curl -X POST http://your-server:3000/api/session/new \
  -H "Content-Type: application/json" \
  -d '{"threadId": "my-session"}'

# Health check
curl http://your-server:3000/health
```

## What About A2A?

[A2A (Agent-to-Agent)](https://a2a-protocol.org) is Google's protocol for **agents talking to other agents** — discovery, capability negotiation, task delegation between opaque systems. It's great if you want:

- Other A2A-compliant agents to delegate coding tasks to your pi agent
- Your pi agent to be discoverable in a multi-agent ecosystem
- Standardized task lifecycle (submitted → working → completed)

For **human-to-agent** interaction (which is what Discord/Slack gives you), A2A adds unnecessary complexity. This project uses pi's SDK directly.

If you want to add A2A later, you'd:
1. Add an Agent Card endpoint (`GET /.well-known/agent.json`) describing capabilities
2. Wrap the `/api/chat` endpoint in A2A's task lifecycle (`tasks/send`, `tasks/get`)
3. Use the `@a2a-js/sdk` or `@artinet/sdk` npm packages

## Deploying with Dokploy

### 1. Push to Git

Push this repo to GitHub/GitLab/Gitea — wherever Dokploy can access it.

```bash
cd pi-remote-agent
git init && git add -A && git commit -m "initial"
git remote add origin git@github.com:you/pi-remote-agent.git
git push -u origin main
```

### 2. Create a Compose project in Dokploy

1. In Dokploy, go to **Projects** → **Create Project**
2. Add a new **Compose** service
3. Under **General**, set the Git source to your repo
4. The `docker-compose.yml` is auto-detected

### 3. Set environment variables

Go to the **Environment** tab and add your keys:

```env
# GitHub access (for cloning and pushing)
GITHUB_TOKEN=github_pat_...
GIT_USER_NAME=Your Name
GIT_USER_EMAIL=you@example.com

WORKSPACE_DIR=/workspace
PORT=3000
MAX_SESSIONS=8

# Optional: Discord
DISCORD_BOT_TOKEN=...
DISCORD_CHANNEL_ID=...

# Optional: Slack
SLACK_BOT_TOKEN=xoxb-...
SLACK_APP_TOKEN=xapp-...
SLACK_SIGNING_SECRET=...
```

These are written to `.env` and loaded via `env_file` in the compose file.

### 4. Set up LLM auth

**Option A: API key** — add `ANTHROPIC_API_KEY=sk-ant-...` to the environment variables.

**Option B: Claude subscription (Pro/Max)** — use your existing subscription:

1. On your local machine, run `pi` and `/login` to authenticate
2. Copy the auth file to your server:
   ```bash
   # On your server, in the Dokploy compose app's files directory:
   mkdir -p files/pi-auth
   ```
3. Copy `~/.pi/agent/auth.json` from your local machine to `files/pi-auth/auth.json` on the server
4. The `docker-compose.yml` already mounts this file into the container
5. Pi handles token refresh automatically

### 5. Set up the workspace

The workspace uses Dokploy's `../files/` persistent storage, which survives across deploys. Repos are cloned automatically when you use the `!repo` command — no manual setup needed.

If you want to pre-clone a repo (via Dokploy terminal or SSH):

```bash
cd /path/to/dokploy/compose/app/files/workspace
git clone https://github.com/you/your-project
```

### 5. Set up domain (optional)

Go to **Domains** tab:
- Add your domain (e.g., `pi.yourdomain.com`)
- Dokploy auto-provisions HTTPS via Let's Encrypt
- Set container port to `3000`

The web UI will be at `https://pi.yourdomain.com` and the WebSocket at `wss://pi.yourdomain.com/ws`.

### 6. Deploy

Click **Deploy**. Dokploy will:
1. Clone your repo
2. Run `docker compose build`
3. Start the container with your env vars
4. The web UI, Discord bot, and Slack bot all start automatically

### Auto-deploy on push

In the **Deployments** tab, enable the webhook. Add it to your GitHub repo settings so pushing to `main` auto-deploys.

### Monitoring

- **Dokploy Logs** tab: see container stdout (startup messages, errors)
- **Dokploy Monitoring** tab: CPU, memory, network
- **Web UI** (`/ui`): see all agent activity in real-time across all interfaces

### Persistence

| Data | Storage | Survives deploy? |
|------|---------|-----------------|
| Workspace (your code) | `../files/workspace` (bind mount) | ✅ Yes |
| Pi sessions | `pi-sessions` named volume | ✅ Yes |
| SSH keys | `../files/ssh` (bind mount, optional) | ✅ Yes |

### Updating the agent

Just push to your repo. If auto-deploy is enabled, Dokploy rebuilds and restarts. Your workspace and sessions are untouched.

---

## Configuration

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes* | Anthropic API key (*or another provider) |
| `OPENAI_API_KEY` | Yes* | OpenAI API key |
| `WORKSPACE_DIR` | No | Workspace path inside container (default: `/workspace`) |
| `PORT` | No | HTTP API port (default: `3000`) |
| `DISCORD_BOT_TOKEN` | No | Enables Discord bot |
| `DISCORD_CHANNEL_ID` | No | Restrict Discord bot to one channel |
| `SLACK_BOT_TOKEN` | No | Enables Slack bot |
| `SLACK_APP_TOKEN` | No | Required for Slack Socket Mode |
| `SLACK_SIGNING_SECRET` | No | Required for Slack |

### Mounting SSH Keys

For git operations inside the container:

```yaml
# docker-compose.yml
volumes:
  - ~/.ssh:/root/.ssh:ro
```

### Custom Pi Configuration

Mount a custom AGENTS.md for project-specific instructions:

```yaml
volumes:
  - ./AGENTS.md:/workspace/AGENTS.md:ro
```

## Security Considerations

⚠️ **The pi agent has full access to the workspace and can run arbitrary commands.**

- Don't expose port 3000 to the public internet without authentication
- Use a dedicated workspace directory, not your entire filesystem
- Consider adding an auth middleware to the Express API
- The Discord/Slack bots only respond to configured channels/users
- Run the container with limited privileges if possible

## Local Development

```bash
# Without Docker
npm install
cp .env.example .env
# Edit .env
npm run dev

# With Docker (uses ./workspace instead of ../files/)
cp .env.example .env
mkdir -p workspace
docker compose -f docker-compose.yml -f docker-compose.local.yml up --build
```
