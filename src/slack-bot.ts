/**
 * Slack bot — forwards messages to Pi agent, posts responses back.
 *
 * Uses Socket Mode (no public URL needed).
 *
 * Usage:
 * - Mention the bot in a channel: @pi-agent help me with X
 * - Threaded conversations maintain session context
 * - "!new" starts a fresh session
 */

import pkg from "@slack/bolt";
const { App } = pkg;
import type { PiAgent, PiResponse } from "./pi-agent.js";

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
    const content = event.text.replace(/<@[A-Z0-9]+>/g, "").trim();

    if (!content) return;

    if (content === "!new") {
      await agent.newSession(threadId);
      await say({ text: "🆕 Started a fresh session.", thread_ts: threadTs });
      return;
    }

    try {
      // Post a "thinking" message
      const thinking = await say({
        text: "🤔 Working on it...",
        thread_ts: threadTs,
      });

      const response = await agent.chat(threadId, content);

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
    // Only handle DMs (channel type "im") without subtypes (edits, etc.)
    if ((event as any).channel_type !== "im" || (event as any).subtype) return;

    const threadId = `slack-dm-${(event as any).user}`;
    const content = (event as any).text || "";

    if (!content) return;

    if (content === "!new") {
      await agent.newSession(threadId);
      await say("🆕 Started a fresh session.");
      return;
    }

    try {
      const response = await agent.chat(threadId, content);
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

  // Slack max is ~40k but we chunk at 3000 for readability
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
