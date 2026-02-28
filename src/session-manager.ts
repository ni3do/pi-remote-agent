/**
 * Manages session lifecycle: creation, idle tracking, LRU eviction, cleanup.
 *
 * - Max 8 concurrent sessions
 * - Idle sessions evicted after 24h
 * - On eviction: commit + push + remove worktree + dispose
 * - LRU eviction when limit reached
 */

import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { WorktreeInfo, WorktreeManager } from "./worktree-manager.js";

export interface ManagedSession {
  threadId: string;
  session: AgentSession;
  worktree: WorktreeInfo | null;
  lastActivity: number;
  source: string;
  createdAt: number;
}

export interface SessionManagerOptions {
  maxSessions?: number;
  idleTimeoutMs?: number;
  worktreeManager: WorktreeManager;
  onEvict?: (managed: ManagedSession) => void;
}

const DEFAULT_MAX_SESSIONS = 8;
const DEFAULT_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

export class SessionLifecycleManager {
  private sessions = new Map<string, ManagedSession>();
  private cleanupInterval: NodeJS.Timeout;
  private maxSessions: number;
  private idleTimeoutMs: number;
  private worktreeManager: WorktreeManager;
  private onEvict?: (managed: ManagedSession) => void;

  constructor(options: SessionManagerOptions) {
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.worktreeManager = options.worktreeManager;
    this.onEvict = options.onEvict;

    // Check for idle sessions every 5 minutes
    this.cleanupInterval = setInterval(() => this.evictIdle(), 5 * 60 * 1000);
  }

  /**
   * Register a new managed session.
   * If at capacity, evicts the least recently used idle session.
   * Returns false if all sessions are busy and at capacity.
   */
  async register(
    threadId: string,
    session: AgentSession,
    worktree: WorktreeInfo | null,
    source: string
  ): Promise<boolean> {
    // Already registered? Update.
    if (this.sessions.has(threadId)) {
      const existing = this.sessions.get(threadId)!;
      existing.session = session;
      existing.worktree = worktree;
      existing.lastActivity = Date.now();
      return true;
    }

    // At capacity? Evict LRU.
    if (this.sessions.size >= this.maxSessions) {
      const evicted = await this.evictLRU();
      if (!evicted) {
        return false; // All sessions active, can't evict
      }
    }

    this.sessions.set(threadId, {
      threadId,
      session,
      worktree,
      lastActivity: Date.now(),
      source,
      createdAt: Date.now(),
    });

    return true;
  }

  /**
   * Mark a session as active (update last activity time).
   */
  touch(threadId: string): void {
    const managed = this.sessions.get(threadId);
    if (managed) {
      managed.lastActivity = Date.now();
    }
  }

  /**
   * Get a managed session by thread ID.
   */
  get(threadId: string): ManagedSession | undefined {
    return this.sessions.get(threadId);
  }

  /**
   * Check if a session exists.
   */
  has(threadId: string): boolean {
    return this.sessions.has(threadId);
  }

  /**
   * Remove and clean up a specific session.
   */
  async remove(threadId: string): Promise<void> {
    const managed = this.sessions.get(threadId);
    if (!managed) return;

    await this.cleanupSession(managed);
    this.sessions.delete(threadId);
  }

  /**
   * Get all active thread IDs.
   */
  getActiveThreads(): string[] {
    return Array.from(this.sessions.keys());
  }

  /**
   * Get session count.
   */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * Get all managed sessions (for monitoring).
   */
  getAll(): ManagedSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Evict sessions idle for longer than idleTimeoutMs.
   */
  private async evictIdle(): Promise<void> {
    const now = Date.now();
    const toEvict: ManagedSession[] = [];

    for (const managed of this.sessions.values()) {
      if (now - managed.lastActivity > this.idleTimeoutMs && !managed.session.isStreaming) {
        toEvict.push(managed);
      }
    }

    for (const managed of toEvict) {
      console.log(
        `[session-manager] Evicting idle session: ${managed.threadId} (idle ${Math.round((now - managed.lastActivity) / 60000)}min)`
      );
      await this.cleanupSession(managed);
      this.sessions.delete(managed.threadId);
      this.onEvict?.(managed);
    }
  }

  /**
   * Evict the least recently used non-streaming session.
   * Returns true if a session was evicted.
   */
  private async evictLRU(): Promise<boolean> {
    let oldest: ManagedSession | null = null;

    for (const managed of this.sessions.values()) {
      if (managed.session.isStreaming) continue; // Don't evict active sessions
      if (!oldest || managed.lastActivity < oldest.lastActivity) {
        oldest = managed;
      }
    }

    if (!oldest) return false;

    console.log(`[session-manager] LRU evicting session: ${oldest.threadId}`);
    await this.cleanupSession(oldest);
    this.sessions.delete(oldest.threadId);
    this.onEvict?.(oldest);
    return true;
  }

  /**
   * Full cleanup: commit + push + remove worktree + dispose session.
   */
  private async cleanupSession(managed: ManagedSession): Promise<void> {
    try {
      // Clean up worktree (commit, push, remove)
      if (managed.worktree) {
        await this.worktreeManager.cleanup(managed.worktree);
      }
    } catch (err) {
      console.error(`[session-manager] Worktree cleanup error for ${managed.threadId}:`, err);
    }

    try {
      managed.session.dispose();
    } catch (err) {
      console.error(`[session-manager] Session dispose error for ${managed.threadId}:`, err);
    }
  }

  /**
   * Dispose all sessions and stop cleanup interval.
   */
  async dispose(): Promise<void> {
    clearInterval(this.cleanupInterval);

    for (const managed of this.sessions.values()) {
      await this.cleanupSession(managed);
    }
    this.sessions.clear();
  }
}
