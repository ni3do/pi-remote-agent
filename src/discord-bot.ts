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
import { isSttEnabled, isAudioMime, transcribe } from "./transcribe.js";

const MAX_DISCORD_LENGTH = 2000;

/**
 * Parse DISCORD_AUTO_CHANNELS env var.
 * Format: comma-separated channel IDs, e.g. "123456789,987654321"
 */
function getAutoChannels(): Set<string> {
  const raw = process.env.DISCORD_AUTO_CHANNELS || "";
  const ids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  return new Set(ids);
}

export function createDiscordBot(agent: PiAgent, token: string) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.DirectMessages,
    ],
  });

  // Track threads where the bot has been tagged or auto-responded
  const activeThreads = new Set<string>();
  const autoChannels = getAutoChannels();

  client.on("ready", () => {
    console.log(`[Discord] Logged in as ${client.user?.tag}`);
  });

  client.on("messageCreate", async (message: Message) => {
    // Ignore own messages and system messages
    if (message.author.bot) return;
    if (message.system) return;

    // In guilds: respond if mentioned, in an active thread, or in an auto-channel
    if (message.guild) {
      const mentioned = message.mentions.has(client.user!);
      const inTaggedThread = message.channel.isThread()
        && activeThreads.has(message.channel.id);
      const inAutoChannel = autoChannels.has(message.channelId);
      const inAutoChannelThread = message.channel.isThread()
        && message.channel.parentId
        && autoChannels.has(message.channel.parentId);

      if (!mentioned && !inTaggedThread && !inAutoChannel && !inAutoChannelThread) return;

      // Track threads for continued conversation
      if (message.channel.isThread()) {
        activeThreads.add(message.channel.id);
      }
    }

    // Use thread ID for session scoping (or DM user ID)
    const threadId = message.channel.isThread()
      ? `discord-${message.channel.id}`
      : `discord-dm-${message.author.id}`;

    let content = message.content
      .replace(new RegExp(`<@!?${client.user!.id}>`), "")
      .trim();

    // Handle voice messages and audio attachments
    if (isSttEnabled() && message.attachments.size > 0) {
      const transcribedParts: string[] = [];

      for (const [, attachment] of message.attachments) {
        // Discord voice messages have contentType audio/ogg and flags with VOICE_MESSAGE bit
        const mime = attachment.contentType?.split(";")[0] || "";
        if (!isAudioMime(mime)) continue;

        try {
          await message.reply("🎙️ Transcribing voice message...");
          const response = await fetch(attachment.url);
          if (!response.ok) throw new Error(`Download failed: ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const text = await transcribe(buffer, mime);
          transcribedParts.push(text);
        } catch (err: any) {
          console.error("[Discord] Transcription error:", err);
          await message.reply(`⚠️ Couldn't transcribe audio: ${err.message?.slice(0, 150)}`);
        }
      }

      if (transcribedParts.length > 0) {
        const transcribed = transcribedParts.join("\n");
        // Show the user what was transcribed
        await message.reply(`🎙️ *Transcribed:* "${transcribed.slice(0, 300)}${transcribed.length > 300 ? "…" : ""}"`);
        // Combine with any text content the user also sent
        content = content ? `${content}\n\n${transcribed}` : transcribed;
      }
    }

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

    // In auto-channels, create a thread for the conversation if not already in one
    let replyTarget: Message = message;
    if (!message.channel.isThread() && autoChannels.has(message.channelId)) {
      try {
        const threadName = content.slice(0, 100) || "Pi Agent";
        const thread = await message.startThread({ name: threadName });
        activeThreads.add(thread.id);
        // Update threadId to use the new thread
        const autoThreadId = `discord-${thread.id}`;
        await thread.sendTyping();
        const typingInterval = setInterval(() => thread.sendTyping(), 8000);

        try {
          const response = await agent.chat(autoThreadId, content, "discord");
          clearInterval(typingInterval);
          await sendResponseToChannel(thread, response);
        } catch (err: any) {
          clearInterval(typingInterval);
          console.error("[Discord] Error:", err);
          await thread.send(`❌ Error: ${err.message?.slice(0, 200)}`);
        }
        return;
      } catch (err: any) {
        console.error("[Discord] Failed to create thread:", err);
      }
    }

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
 * Format a Pi response for Discord's markdown flavor.
 *
 * Discord supports: **bold**, *italic*, `inline code`, ```code blocks```,
 * > blockquotes, - lists, ||spoilers||, ~~strikethrough~~, headings (#, ##, ###)
 *
 * What Discord does NOT support (that standard markdown does):
 * - HTML tags (stripped)
 * - Tables (render as plain text)
 * - Images via ![]() (shows as link)
 *
 * This function cleans up the agent's markdown to look good on Discord.
 */
function formatForDiscord(text: string): string {
  let result = text;

  // Convert HTML tables to simple text (agent sometimes generates these)
  result = result.replace(/<table[\s\S]*?<\/table>/g, (match) => {
    // Extract text content from table cells
    const rows = match.match(/<tr[\s\S]*?<\/tr>/g) || [];
    return rows
      .map((row) => {
        const cells = row.match(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g) || [];
        return cells
          .map((cell) => cell.replace(/<[^>]+>/g, "").trim())
          .join(" | ");
      })
      .join("\n");
  });

  // Strip any remaining HTML tags
  result = result.replace(/<[^>]+>/g, "");

  // Collapse 3+ consecutive blank lines to 2
  result = result.replace(/\n{3,}/g, "\n\n");

  return result;
}

/**
 * Build a tool call summary section for Discord.
 * Groups by tool and uses Discord formatting.
 */
function formatToolSummary(toolCalls: PiResponse["toolCalls"]): string {
  if (toolCalls.length === 0) return "";

  // Group tool calls for a cleaner summary
  const grouped = new Map<string, { count: number; errors: number }>();
  for (const tc of toolCalls) {
    const key = tc.tool;
    const existing = grouped.get(key) || { count: 0, errors: 0 };
    existing.count++;
    if (tc.isError) existing.errors++;
    grouped.set(key, existing);
  }

  // If few tool calls, show individually; if many, show grouped
  if (toolCalls.length <= 5) {
    const lines = toolCalls.map((tc) => {
      const status = tc.isError ? "❌" : "✅";
      return `${status} \`${tc.tool}\``;
    });
    return "\n\n> 🔧 **Tools used:**\n> " + lines.join("\n> ");
  }

  const lines: string[] = [];
  for (const [tool, info] of grouped) {
    const status = info.errors > 0 ? "⚠️" : "✅";
    const count = info.count > 1 ? ` ×${info.count}` : "";
    const errors = info.errors > 0 ? ` (${info.errors} failed)` : "";
    lines.push(`${status} \`${tool}\`${count}${errors}`);
  }
  return "\n\n> 🔧 **Tools used:**\n> " + lines.join("\n> ");
}

/**
 * Send a PiResponse back to Discord, chunking if needed.
 * Formats markdown for Discord's rendering engine.
 */
async function sendResponse(message: Message, response: PiResponse) {
  const formattedText = formatForDiscord(response.text);
  const toolSummary = formatToolSummary(response.toolCalls);

  const fullText = (formattedText + toolSummary).trim();

  if (!fullText) {
    await message.reply("_(No response)_");
    return;
  }

  // Chunk into Discord-safe sizes, respecting code block boundaries
  const chunks = chunkText(fullText, MAX_DISCORD_LENGTH);
  for (const chunk of chunks) {
    await message.reply(chunk);
  }
}

/**
 * Send a PiResponse to a channel/thread (not as a reply to a specific message).
 */
async function sendResponseToChannel(channel: TextChannel | ThreadChannel, response: PiResponse) {
  const formattedText = formatForDiscord(response.text);
  const toolSummary = formatToolSummary(response.toolCalls);

  const fullText = (formattedText + toolSummary).trim();

  if (!fullText) {
    await channel.send("_(No response)_");
    return;
  }

  const chunks = chunkText(fullText, MAX_DISCORD_LENGTH);
  for (const chunk of chunks) {
    await channel.send(chunk);
  }
}

/**
 * Chunk text into Discord-safe sizes.
 * Respects code block boundaries — if a chunk splits inside a ```code block```,
 * closes it at the end of the chunk and reopens it in the next.
 */
function chunkText(text: string, maxLen: number): string[] {
  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }

    // Try to break at a newline, preferring one before maxLen
    let breakAt = remaining.lastIndexOf("\n", maxLen);
    if (breakAt < maxLen / 2) breakAt = maxLen;

    let chunk = remaining.slice(0, breakAt);
    remaining = remaining.slice(breakAt);

    // Check if we're inside an unclosed code block
    const backtickMatches = chunk.match(/```/g);
    const unclosed = backtickMatches && backtickMatches.length % 2 !== 0;

    if (unclosed) {
      // Find the language specifier from the last opening ```
      const lastOpen = chunk.lastIndexOf("```");
      const afterOpen = chunk.slice(lastOpen + 3);
      const langMatch = afterOpen.match(/^(\w*)\n/);
      const lang = langMatch ? langMatch[1] : "";

      // Close the code block in this chunk
      chunk += "\n```";
      // Reopen it in the next chunk
      remaining = "```" + lang + "\n" + remaining;
    }

    chunks.push(chunk);
  }

  return chunks;
}
