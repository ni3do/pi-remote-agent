/**
 * Discord bot — forwards messages to Pi agent, posts responses back.
 *
 * Usage:
 * - DM the bot or mention it in a channel
 * - Threaded conversations maintain session context
 * - "!new" starts a fresh session
 * - "!repo <url> [description]" sets up a repo with worktree
 * - "!status" shows current session info
 */

import {
  Client,
  GatewayIntentBits,
  type Message,
  type TextChannel,
  type ThreadChannel,
} from "discord.js";
import type { PiAgent, PiResponse } from "./pi-agent.js";

const MAX_DISCORD_LENGTH = 2000;

export function createDiscordBot(agent: PiAgent, token: string, channelId?: string) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  client.on("ready", () => {
    console.log(`[Discord] Logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore own messages and system messages
    if (message.author.bot) return;
    if (message.system) return;

    // In guilds: respond if mentioned, in configured channel, or in a thread we're already in
    if (message.guild) {
      const mentioned = message.mentions.has(client.user!);
      const inChannel = channelId && message.channelId === channelId;
      const inActiveThread = message.channel.isThread()
        && agent.getActiveThreads().includes(`discord-${message.channel.id}`);
      if (!mentioned && !inChannel && !inActiveThread) return;
    }

    // Use thread ID for session scoping (or DM user ID)
    const threadId = message.channel.isThread()
      ? `discord-${message.channel.id}`
      : `discord-dm-${message.author.id}`;

    const content = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`), "")
      .trim();

    if (!content) return;

    // === Commands ===
    if (content === "!new") {
      await agent.newSession(threadId);
      await message.reply("🆕 Started a fresh session.");
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
        await message.reply(
          `✅ Session active (idle ${idle}min)${wt}\n📊 ${sessions.length}/8 sessions`
        );
      } else {
        await message.reply(`💤 No active session.\n📊 ${sessions.length}/8 sessions`);
      }
      return;
    }

    // !repo <url> [description]
    const repoMatch = content.match(/^!repo\s+(https?:\/\/\S+)(?:\s+(.+))?$/i);
    if (repoMatch) {
      const repoUrl = repoMatch[1];
      const description = repoMatch[2] || "work";

      await message.reply(`📦 Setting up repo: \`${repoUrl}\`...`);
      try {
        await agent.setupSession(threadId, repoUrl, description, "discord");
        await message.reply(`✅ Ready! Worktree created. Start chatting.`);
      } catch (err: any) {
        await message.reply(`❌ Setup failed: ${err.message?.slice(0, 200)}`);
      }
      return;
    }

    // === Chat ===
    const channel = message.channel as TextChannel;
    await channel.sendTyping();
    const typingInterval = setInterval(() => channel.sendTyping(), 8000);

    try {
      // Gather thread context if this is a resumed session (no active session for this thread)
      let threadContext: string | undefined;
      if (!agent.getActiveThreads().includes(threadId) && message.channel.isThread()) {
        threadContext = await getThreadContext(message.channel as ThreadChannel);
      }

      const response = await agent.chat(threadId, content, "discord", { threadContext });
      clearInterval(typingInterval);
      await sendResponse(message, response);
    } catch (err: any) {
      clearInterval(typingInterval);
      console.error("[Discord] Error:", err);
      await message.reply(`❌ Error: ${err.message?.slice(0, 200)}`);
    }
  });

  client.login(token);
  return client;
}

/**
 * Fetch recent thread messages for context injection.
 */
async function getThreadContext(thread: ThreadChannel): Promise<string | undefined> {
  try {
    const messages = await thread.messages.fetch({ limit: 50 });
    if (messages.size <= 1) return undefined;

    const lines = messages
      .reverse()
      .map((m) => {
        const role = m.author.bot ? "agent" : "user";
        const text = m.content.slice(0, 500);
        return `[${role}]: ${text}`;
      })
      .filter((_, i, arr) => i < arr.length - 1); // Exclude the current message

    return lines.length > 0 ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Send a PiResponse back to Discord, chunking if needed.
 */
async function sendResponse(message: Message, response: PiResponse) {
  // Build tool call summary
  let toolSummary = "";
  if (response.toolCalls.length > 0) {
    const lines = response.toolCalls.map((tc) => {
      const status = tc.isError ? "❌" : "✅";
      const argStr =
        typeof tc.args === "object"
          ? Object.entries(tc.args)
              .map(([k, v]) => `${k}: ${String(v).slice(0, 100)}`)
              .join(", ")
          : String(tc.args);
      return `${status} **${tc.tool}**(${argStr.slice(0, 150)})`;
    });
    toolSummary = "\n\n🔧 **Tools used:**\n" + lines.join("\n");
  }

  const fullText = (response.text + toolSummary).trim();

  if (!fullText) {
    await message.reply("_(No response)_");
    return;
  }

  // Chunk into Discord-safe sizes
  const chunks = chunkText(fullText, MAX_DISCORD_LENGTH);
  for (const chunk of chunks) {
    await message.reply(chunk);
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
