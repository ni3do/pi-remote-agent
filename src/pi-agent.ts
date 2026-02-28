/**
 * Pi Agent wrapper — manages AgentSession lifecycle.
 * One session per "conversation" (Discord thread, Slack thread, etc.)
 * Emits events for real-time monitoring via WebSocket.
 */

import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  createCodingTools,
  type AgentSession,
  type AgentSessionEvent,
} from "@mariozechner/pi-coding-agent";
import { EventEmitter } from "events";

export interface PiAgentOptions {
  workspaceDir: string;
  provider?: string;
  modelId?: string;
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

export class PiAgent extends EventEmitter {
  private sessions = new Map<string, AgentSession>();
  private options: PiAgentOptions;
  private authStorage: ReturnType<typeof AuthStorage.create>;
  private modelRegistry: ModelRegistry;

  constructor(options: PiAgentOptions) {
    super();
    this.options = options;
    this.authStorage = AuthStorage.create();
    this.modelRegistry = new ModelRegistry(this.authStorage);
  }

  /**
   * Get or create a session for a conversation thread.
   * Each Discord/Slack thread gets its own session with full history.
   */
  private async getSession(threadId: string): Promise<AgentSession> {
    if (this.sessions.has(threadId)) {
      return this.sessions.get(threadId)!;
    }

    const cwd = this.options.workspaceDir;

    const { session } = await createAgentSession({
      cwd,
      tools: createCodingTools(cwd),
      sessionManager: SessionManager.create(cwd),
      settingsManager: SettingsManager.create(cwd),
      authStorage: this.authStorage,
      modelRegistry: this.modelRegistry,
    });

    this.sessions.set(threadId, session);
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
   * Send a message and collect the full response.
   * Streams events in real-time for monitoring.
   */
  async chat(threadId: string, message: string, source = "api"): Promise<PiResponse> {
    const session = await this.getSession(threadId);

    let text = "";
    const toolCalls: PiResponse["toolCalls"] = [];

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
      await session.prompt(message);
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
    return Array.from(this.sessions.keys());
  }

  /**
   * Start a new session for a thread (clears history).
   */
  async newSession(threadId: string): Promise<void> {
    const existing = this.sessions.get(threadId);
    if (existing) {
      existing.dispose();
      this.sessions.delete(threadId);
    }
    this.broadcast(threadId, "system", "session_cleared", {});
  }

  /**
   * Clean up all sessions.
   */
  dispose(): void {
    for (const session of this.sessions.values()) {
      session.dispose();
    }
    this.sessions.clear();
  }
}
