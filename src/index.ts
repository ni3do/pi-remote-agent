/**
 * Entry point — starts Pi agent + whichever interfaces are configured.
 */

import "dotenv/config";
import { PiAgent } from "./pi-agent.js";
import { createApi } from "./api.js";

const workspaceDir = process.env.WORKSPACE_DIR || "/workspace";
const port = parseInt(process.env.PORT || "3000");
const maxSessions = parseInt(process.env.MAX_SESSIONS || "8");

console.log(`[pi-remote] Workspace: ${workspaceDir}`);
console.log(`[pi-remote] Max sessions: ${maxSessions}`);

// Create the shared Pi agent
const agent = new PiAgent({ workspaceDir, maxSessions });

// Always start the HTTP API + WebSocket + Web UI
createApi(agent, port);

// Start Discord bot if configured
if (process.env.DISCORD_BOT_TOKEN) {
  try {
    const { createDiscordBot } = await import("./discord-bot.js");
    const client = createDiscordBot(agent, process.env.DISCORD_BOT_TOKEN);
    client.on("error", (err) => console.error("[Discord] Error (non-fatal):", err.message));
    console.log("[pi-remote] Discord bot enabled");
  } catch (err: any) {
    console.error("[pi-remote] Discord bot failed to start:", err.message);
  }
} else {
  console.log("[pi-remote] Discord bot disabled (no DISCORD_BOT_TOKEN)");
}

// Start Slack bot if configured
if (process.env.SLACK_BOT_TOKEN && process.env.SLACK_APP_TOKEN && process.env.SLACK_SIGNING_SECRET) {
  const { createSlackBot } = await import("./slack-bot.js");
  createSlackBot(
    agent,
    process.env.SLACK_BOT_TOKEN,
    process.env.SLACK_APP_TOKEN,
    process.env.SLACK_SIGNING_SECRET
  );
  console.log("[pi-remote] Slack bot enabled");
} else {
  console.log("[pi-remote] Slack bot disabled (missing SLACK_* env vars)");
}

// Don't crash on unhandled errors
process.on("uncaughtException", (err) => {
  console.error("[pi-remote] Uncaught exception (non-fatal):", err.message);
});
process.on("unhandledRejection", (err: any) => {
  console.error("[pi-remote] Unhandled rejection (non-fatal):", err?.message || err);
});

// Graceful shutdown — commits, pushes, and cleans up all worktrees
const shutdown = async () => {
  console.log("[pi-remote] Shutting down (cleaning up worktrees)...");
  await agent.dispose();
  console.log("[pi-remote] Cleanup complete.");
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
