/**
 * Discord bot — forwards messages to Pi agent, posts responses back.
 *
 * Usage:
 * - DM the bot or mention it in a channel
 * - Threaded conversations maintain session context
 * - "!new" starts a fresh session
 * - "!status" shows current session info
 */

import { Client, GatewayIntentBits, type Message, type TextChannel } from "discord.js";
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
    // Ignore own messages
    if (message.author.bot) return;

    // In guilds, only respond if mentioned or in the configured channel
    if (message.guild) {
      const mentioned = message.mentions.has(client.user!);
      const inChannel = channelId && message.channelId === channelId;
      if (!mentioned && !inChannel) return;
    }

    // Use thread ID for session scoping (or channel ID if not in thread)
    const threadId = message.channel.isThread()
      ? message.channel.id
      : `dm-${message.author.id}`;

    const content = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`), "")
      .trim();

    if (!content) return;

    // Commands
    if (content === "!new") {
      await agent.newSession(threadId);
      await message.reply("🆕 Started a fresh session.");
      return;
    }

    if (content === "!status") {
      await message.reply("✅ Pi agent is running.");
      return;
    }

    // Show typing indicator
    const channel = message.channel as TextChannel;
    await channel.sendTyping();
    const typingInterval = setInterval(() => channel.sendTyping(), 8000);

    try {
      const response = await agent.chat(threadId, content);
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
    // Try to break at a newline
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen / 2) breakAt = maxLen;
    chunks.push(remaining.slice(0, breakAt));
    remaining = remaining.slice(breakAt);
  }
  return chunks;
}
