/**
 * Slack bot — forwards messages to Pi agent, posts responses back.
 *
 * Uses Socket Mode (no public URL needed).
 *
 * Usage:
 * - Mention the bot in a channel: @pi-agent help me with X
 * - Threaded conversations maintain session context
 * - "!new" starts a fresh session
 * - "!repo <url> [description]" sets up a repo with worktree
 */

import pkg from "@slack/bolt";
const { App } = pkg;
import type { PiAgent, PiResponse } from "./pi-agent.js";
import { isSttEnabled, isAudioMime, transcribe } from "./transcribe.js";

export function createSlackBot(
  agent: PiAgent,
  botToken: string,
  appToken: string,
  signingSecret: string
) {
  const app = new App({
    token: botToken,
    appToken,
    signingSecret,
    socketMode: true,
  });

  // Respond to mentions
  app.event("app_mention", async ({ event, say, client }) => {
    const threadTs = event.thread_ts || event.ts;
    const threadId = `slack-${event.channel}-${threadTs}`;
    let content = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    // Handle audio file uploads
    if (isSttEnabled() && (event as any).files?.length > 0) {
      const transcribed = await transcribeSlackFiles(
        (event as any).files,
        app.client,
        async (text) => { await say({ text, thread_ts: threadTs }); }
      );
      if (transcribed) {
        content = content ? `${content}\n\n${transcribed}` : transcribed;
      }
    }

    if (!content) return;

    // === Commands ===
    if (content === "!new") {
      await agent.newSession(threadId);
      await say({ text: "🆕 Started a fresh session.", thread_ts: threadTs });
      return;
    }

    if (content === "!status") {
      const sessions = agent.getSessionInfo();
      const current = sessions.find((s) => s.threadId === threadId);
      if (current) {
        const idle = Math.round((Date.now() - current.lastActivity) / 60000);
        const wt = current.worktree
          ? `\n📂 Worktree: \`${current.worktree.branch}\` (${current.worktree.repo})`
          : "\n📂 No worktree";
        await say({
          text: `✅ Session active (idle ${idle}min)${wt}\n📊 ${sessions.length}/8 sessions`,
          thread_ts: threadTs,
        });
      } else {
        await say({
          text: `💤 No active session.\n📊 ${sessions.length}/8 sessions`,
          thread_ts: threadTs,
        });
      }
      return;
    }

    // !repo <url> [description]
    const repoMatch = content.match(/^!repo\s+(https?:\/\/\S+)(?:\s+(.+))?$/i);
    if (repoMatch) {
      const repoUrl = repoMatch[1];
      const description = repoMatch[2] || "work";

      await say({ text: `📦 Setting up repo: \`${repoUrl}\`...`, thread_ts: threadTs });
      try {
        await agent.setupSession(threadId, repoUrl, description, "slack");
        await say({ text: `✅ Ready! Worktree created. Start chatting.`, thread_ts: threadTs });
      } catch (err: any) {
        await say({
          text: `❌ Setup failed: ${err.message?.slice(0, 500)}`,
          thread_ts: threadTs,
        });
      }
      return;
    }

    // === Chat ===
    try {
      const thinking = await say({
        text: "🤔 Working on it...",
        thread_ts: threadTs,
      });

      // Gather thread context if this is a resumed session
      let threadContext: string | undefined;
      if (!agent.getActiveThreads().includes(threadId)) {
        threadContext = await getSlackThreadContext(client, event.channel, threadTs);
      }

      const response = await agent.chat(threadId, content, "slack", { threadContext });

      // Delete thinking message
      if (thinking.ts) {
        await client.chat.delete({
          channel: event.channel,
          ts: thinking.ts,
        });
      }

      await postResponse(say, threadTs, response);
    } catch (err: any) {
      console.error("[Slack] Error:", err);
      await say({
        text: `❌ Error: ${err.message?.slice(0, 500)}`,
        thread_ts: threadTs,
      });
    }
  });

  // Respond to DMs
  app.event("message", async ({ event, say, client }) => {
    if ((event as any).channel_type !== "im" || (event as any).subtype) return;

    const threadId = `slack-dm-${(event as any).user}`;
    let content = (event as any).text || "";

    // Handle audio file uploads in DMs
    if (isSttEnabled() && (event as any).files?.length > 0) {
      const transcribed = await transcribeSlackFiles(
        (event as any).files,
        app.client,
        async (text) => { await say(text); }
      );
      if (transcribed) {
        content = content ? `${content}\n\n${transcribed}` : transcribed;
      }
    }

    if (!content) return;

    if (content === "!new") {
      await agent.newSession(threadId);
      await say("🆕 Started a fresh session.");
      return;
    }

    // !repo command in DMs
    const repoMatch = content.match(/^!repo\s+(https?:\/\/\S+)(?:\s+(.+))?$/i);
    if (repoMatch) {
      const repoUrl = repoMatch[1];
      const description = repoMatch[2] || "work";
      await say(`📦 Setting up repo: \`${repoUrl}\`...`);
      try {
        await agent.setupSession(threadId, repoUrl, description, "slack");
        await say(`✅ Ready! Worktree created. Start chatting.`);
      } catch (err: any) {
        await say(`❌ Setup failed: ${err.message?.slice(0, 500)}`);
      }
      return;
    }

    try {
      const response = await agent.chat(threadId, content, "slack");
      await postResponse(say, undefined, response);
    } catch (err: any) {
      console.error("[Slack] Error:", err);
      await say(`❌ Error: ${err.message?.slice(0, 500)}`);
    }
  });

  app.start().then(() => {
    console.log("[Slack] Bot is running in Socket Mode");
  });

  return app;
}

/**
 * Transcribe audio files from a Slack message.
 * Downloads each audio file via Slack API and runs Whisper.
 */
async function transcribeSlackFiles(
  files: any[],
  client: any,
  notify: (text: string) => Promise<void>
): Promise<string | null> {
  const parts: string[] = [];

  for (const file of files) {
    const mime = file.mimetype || "";
    if (!isAudioMime(mime)) continue;

    try {
      await notify("🎙️ Transcribing voice message...");

      // Download file from Slack (requires files:read scope)
      const downloadUrl = file.url_private_download || file.url_private;
      if (!downloadUrl) throw new Error("No download URL for file");

      const response = await fetch(downloadUrl, {
        headers: { Authorization: `Bearer ${client.token}` },
      });
      if (!response.ok) throw new Error(`Download failed: ${response.status}`);

      const buffer = Buffer.from(await response.arrayBuffer());
      const text = await transcribe(buffer, mime);
      parts.push(text);

      await notify(`🎙️ *Transcribed:* "${text.slice(0, 300)}${text.length > 300 ? "…" : ""}"`);
    } catch (err: any) {
      console.error("[Slack] Transcription error:", err);
      await notify(`⚠️ Couldn't transcribe audio: ${err.message?.slice(0, 150)}`);
    }
  }

  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Fetch recent thread messages from Slack for context injection.
 */
async function getSlackThreadContext(
  client: any,
  channel: string,
  threadTs: string
): Promise<string | undefined> {
  try {
    const result = await client.conversations.replies({
      channel,
      ts: threadTs,
      limit: 50,
    });

    const messages = result.messages || [];
    if (messages.length <= 1) return undefined;

    const lines = messages
      .slice(0, -1) // Exclude the current message
      .map((m: any) => {
        const role = m.bot_id ? "agent" : "user";
        const text = (m.text || "").slice(0, 500);
        return `[${role}]: ${text}`;
      });

    return lines.length > 0 ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

async function postResponse(
  say: Function,
  threadTs: string | undefined,
  response: PiResponse
) {
  let text = response.text;

  if (response.toolCalls.length > 0) {
    const lines = response.toolCalls.map((tc) => {
      const status = tc.isError ? "❌" : "✅";
      return `${status} *${tc.tool}*`;
    });
    text += "\n\n🔧 *Tools used:*\n" + lines.join("\n");
  }

  if (!text.trim()) {
    text = "_(No response)_";
  }

  const chunks = chunkText(text.trim(), 3000);
  for (const chunk of chunks) {
    await say({ text: chunk, thread_ts: threadTs });
  }
}

function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen / 2) breakAt = maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return chunks;
}
