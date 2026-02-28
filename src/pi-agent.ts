/**
 * Pi Agent — manages AgentSession lifecycle with worktree-based isolation.
 *
 * Flow:
 *   1. User sends "work on currico, fix auth bug"
 *   2. Agent parses repo + description
 *   3. Clone repo if needed, create worktree + branch
 *   4. Create AgentSession with cwd = worktree path
 *   5. Work happens in isolated worktree
 *   6. On cleanup: commit + push + remove worktree
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager as PiSessionManager,
  SettingsManager,
  createCodingTools,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { EventEmitter } from "events";
import { WorktreeManager, type WorktreeInfo } from "./worktree-manager.js";
import { SessionLifecycleManager } from "./session-manager.js";

export interface PiAgentOptions {
  workspaceDir: string;
  maxSessions?: number;
  idleTimeoutMs?: number;
}

export interface PiResponse {
  text: string;
  toolCalls: Array<{ tool: string; args: any; result: string; isError: boolean }>;
}

/** Events broadcast to all listeners (WebSocket clients, etc.) */
export interface PiEvent {
  threadId: string;
  source: string; // "discord", "slack", "web", "api"
  timestamp: number;
  type: string;
  data: any;
}

/** Parsed intent from user's first message */
interface WorkIntent {
  repoUrl: string;
  description: string;
}

export class PiAgent extends EventEmitter {
  private options: PiAgentOptions;
  private authStorage: ReturnType<typeof AuthStorage.create>;
  private modelRegistry: ModelRegistry;
  private worktreeManager: WorktreeManager;
  private lifecycle: SessionLifecycleManager;

  constructor(options: PiAgentOptions) {
    super();
    this.options = options;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
    this.worktreeManager = new WorktreeManager(options.workspaceDir);
    this.lifecycle = new SessionLifecycleManager({
      maxSessions: options.maxSessions ?? 8,
      idleTimeoutMs: options.idleTimeoutMs,
      worktreeManager: this.worktreeManager,
      onEvict: (managed) => {
        this.broadcast(managed.threadId, "system", "session_evicted", {
          reason: "idle_timeout",
        });
      },
    });
  }

  /**
   * Get or create a session for a thread.
   * If the thread has a repo context, creates a worktree.
   * If no repo context, uses the base workspace directory.
   */
  private async getOrCreateSession(
    threadId: string,
    source: string,
    repoUrl?: string,
    description?: string
  ): Promise<AgentSession> {
    // Existing session? Touch and return.
    const existing = this.lifecycle.get(threadId);
    if (existing) {
      this.lifecycle.touch(threadId);
      return existing.session;
    }

    let cwd = this.options.workspaceDir;
    let worktree: WorktreeInfo | null = null;

    // If repo URL provided, set up worktree
    if (repoUrl) {
      const repoPath = this.worktreeManager.ensureCloned(repoUrl);
      const desc = description || "work";
      const shortId = threadId.slice(0, 8).replace(/[^a-z0-9]/gi, "");
      worktree = this.worktreeManager.create(repoPath, desc, shortId);
      cwd = worktree.path;
      this.broadcast(threadId, source, "worktree_created", {
        path: worktree.path,
        branch: worktree.branch,
        repo: worktree.repoName,
      });
    }

    const { session } = await createAgentSession({
      cwd,
      tools: createCodingTools(cwd),
      sessionManager: PiSessionManager.create(cwd),
      settingsManager: SettingsManager.create(cwd),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    const registered = await this.lifecycle.register(threadId, session, worktree, source);
    if (!registered) {
      session.dispose();
      throw new Error("All sessions are busy. Try again later.");
    }

    return session;
  }

  /** Broadcast a PiEvent to all listeners */
  private broadcast(threadId: string, source: string, type: string, data: any) {
    const event: PiEvent = {
      threadId,
      source,
      timestamp: Date.now(),
      type,
      data,
    };
    this.emit("pi_event", event);
  }

  /**
   * Set up a session with a specific repo.
   * Call this before chat() if you know the repo upfront.
   */
  async setupSession(
    threadId: string,
    repoUrl: string,
    description: string,
    source = "api"
  ): Promise<void> {
    await this.getOrCreateSession(threadId, source, repoUrl, description);
  }

  /**
   * Send a message and collect the full response.
   * Streams events in real-time for monitoring.
   *
   * Options:
   * - repoUrl: GitHub repo URL to clone/worktree (for first message)
   * - description: short description for branch naming
   * - threadContext: previous messages from Discord/Slack thread (for resumed sessions)
   */
  async chat(
    threadId: string,
    message: string,
    source = "api",
    options?: {
      repoUrl?: string;
      description?: string;
      threadContext?: string;
    }
  ): Promise<PiResponse> {
    const session = await this.getOrCreateSession(
      threadId,
      source,
      options?.repoUrl,
      options?.description
    );

    this.lifecycle.touch(threadId);

    let text = "";
    const toolCalls: PiResponse["toolCalls"] = [];

    // Build the full prompt, including thread context if provided
    let fullMessage = message;
    if (options?.threadContext) {
      fullMessage = `Previous conversation context from this thread:\n${options.threadContext}\n\nNew message: ${message}`;
    }

    // Broadcast user message
    this.broadcast(threadId, source, "user_message", { message });

    // Collect streaming events and broadcast them
    const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
      switch (event.type) {
        case "message_update":
          if (event.assistantMessageEvent.type === "text_delta") {
            text += event.assistantMessageEvent.delta;
            this.broadcast(threadId, source, "text_delta", {
              delta: event.assistantMessageEvent.delta,
            });
          }
          if (event.assistantMessageEvent.type === "thinking_delta") {
            this.broadcast(threadId, source, "thinking_delta", {
              delta: (event.assistantMessageEvent as any).delta,
            });
          }
          break;

        case "tool_execution_start":
          this.broadcast(threadId, source, "tool_start", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            args: event.args,
          });
          break;

        case "tool_execution_update":
          this.broadcast(threadId, source, "tool_update", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            partialResult: event.partialResult?.content
              ?.map((c: any) => (c.type === "text" ? c.text : "[non-text]"))
              .join("\n"),
          });
          break;

        case "tool_execution_end":
          const result = event.result.content
            .map((c: any) => (c.type === "text" ? c.text : "[non-text]"))
            .join("\n");
          toolCalls.push({
            tool: event.toolName,
            args: event.args,
            result,
            isError: event.isError,
          });
          this.broadcast(threadId, source, "tool_end", {
            toolCallId: event.toolCallId,
            tool: event.toolName,
            args: event.args,
            result,
            isError: event.isError,
          });
          break;

        case "agent_start":
          this.broadcast(threadId, source, "agent_start", {});
          break;

        case "agent_end":
          this.broadcast(threadId, source, "agent_end", {});
          break;

        case "turn_start":
          this.broadcast(threadId, source, "turn_start", {});
          break;

        case "turn_end":
          this.broadcast(threadId, source, "turn_end", {});
          break;

        case "auto_compaction_start":
          this.broadcast(threadId, source, "compaction_start", {});
          break;

        case "auto_compaction_end":
          this.broadcast(threadId, source, "compaction_end", {});
          break;
      }
    });

    try {
      await session.prompt(fullMessage);
    } finally {
      unsubscribe();
    }

    // Broadcast completed response
    this.broadcast(threadId, source, "response_complete", {
      text,
      toolCalls,
    });

    return { text, toolCalls };
  }

  /** Get list of active session thread IDs */
  getActiveThreads(): string[] {
    return this.lifecycle.getActiveThreads();
  }

  /** Get info about all managed sessions (for monitoring) */
  getSessionInfo(): Array<{
    threadId: string;
    source: string;
    lastActivity: number;
    createdAt: number;
    worktree: { path: string; branch: string; repo: string } | null;
  }> {
    return this.lifecycle.getAll().map((m) => ({
      threadId: m.threadId,
      source: m.source,
      lastActivity: m.lastActivity,
      createdAt: m.createdAt,
      worktree: m.worktree
        ? { path: m.worktree.path, branch: m.worktree.branch, repo: m.worktree.repoName }
        : null,
    }));
  }

  /**
   * Start a new session for a thread (clears existing).
   */
  async newSession(threadId: string): Promise<void> {
    await this.lifecycle.remove(threadId);
    this.broadcast(threadId, "system", "session_cleared", {});
  }

  /**
   * Clean up all sessions.
   */
  async dispose(): Promise<void> {
    await this.lifecycle.dispose();
  }
}
