/**
 * Manages git repo cloning and worktree lifecycle.
 *
 * Structure:
 *   /workspace/
 *     currico/                          ← base checkout (main branch)
 *     currico-wt-fix-auth-a1b2c3/       ← worktree for a session
 */

import { execSync } from "child_process";
import { existsSync, rmSync } from "fs";
import { basename, join } from "path";

export interface WorktreeInfo {
  /** Absolute path to the worktree directory */
  path: string;
  /** Branch name created for this worktree */
  branch: string;
  /** Base repo directory */
  repoPath: string;
  /** Repo name (e.g. "currico") */
  repoName: string;
}

export class WorktreeManager {
  constructor(private workspaceDir: string) {}

  /**
   * Ensure a repo is cloned. Returns the base repo path.
   */
  ensureCloned(repoUrl: string): string {
    // Extract repo name from URL: "https://github.com/user/currico.git" → "currico"
    const repoName = basename(repoUrl, ".git").replace(/\.git$/, "");
    const repoPath = join(this.workspaceDir, repoName);

    if (existsSync(join(repoPath, ".git"))) {
      // Already cloned — fetch latest
      console.log(`[worktree] Fetching latest for ${repoName}...`);
      this.exec(`git fetch --all`, repoPath);
      return repoPath;
    }

    console.log(`[worktree] Cloning ${repoUrl}...`);
    this.exec(`git clone ${repoUrl} ${repoPath}`);
    return repoPath;
  }

  /**
   * Create a worktree for a session.
   * Returns the worktree info with path and branch name.
   */
  create(repoPath: string, description: string, sessionId: string): WorktreeInfo {
    const repoName = basename(repoPath);
    const shortId = sessionId.slice(0, 6);
    const safeName = description
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 30);

    const branch = `wt/${safeName}-${shortId}`;
    const worktreeDirName = `${repoName}-wt-${safeName}-${shortId}`;
    const worktreePath = join(this.workspaceDir, worktreeDirName);

    if (existsSync(worktreePath)) {
      console.log(`[worktree] Already exists: ${worktreeDirName}`);
      return { path: worktreePath, branch, repoPath, repoName };
    }

    // Get default branch
    const defaultBranch = this.getDefaultBranch(repoPath);

    // Create branch from default and add worktree
    console.log(`[worktree] Creating worktree: ${worktreeDirName} (branch: ${branch})`);
    this.exec(`git worktree add -b "${branch}" "${worktreePath}" "${defaultBranch}"`, repoPath);

    // Install dependencies if package.json exists
    if (existsSync(join(worktreePath, "package.json"))) {
      console.log(`[worktree] Installing dependencies in ${worktreeDirName}...`);
      try {
        this.exec("npm install", worktreePath);
      } catch (err) {
        console.warn(`[worktree] npm install failed (non-fatal):`, err);
      }
    }

    return { path: worktreePath, branch, repoPath, repoName };
  }

  /**
   * Cleanup a worktree: commit uncommitted changes, push, remove.
   */
  async cleanup(info: WorktreeInfo): Promise<void> {
    const { path: wtPath, branch, repoPath } = info;

    if (!existsSync(wtPath)) {
      console.log(`[worktree] Already removed: ${wtPath}`);
      return;
    }

    try {
      // Check for uncommitted changes
      const status = this.exec("git status --porcelain", wtPath);
      if (status.trim()) {
        console.log(`[worktree] Committing uncommitted changes in ${basename(wtPath)}...`);
        this.exec("git add -A", wtPath);
        this.exec(
          `git commit -m "auto-commit: session cleanup (uncommitted changes)"`,
          wtPath
        );
      }

      // Push the branch
      console.log(`[worktree] Pushing branch ${branch}...`);
      try {
        this.exec(`git push origin "${branch}"`, wtPath);
      } catch (err) {
        console.warn(`[worktree] Push failed (branch may not have remote):`, err);
      }
    } catch (err) {
      console.error(`[worktree] Error during cleanup commit/push:`, err);
    }

    // Remove worktree
    try {
      console.log(`[worktree] Removing worktree ${basename(wtPath)}...`);
      this.exec(`git worktree remove "${wtPath}" --force`, repoPath);
    } catch (err) {
      console.warn(`[worktree] git worktree remove failed, removing directory manually`);
      rmSync(wtPath, { recursive: true, force: true });
      // Prune stale worktree entries
      try {
        this.exec("git worktree prune", repoPath);
      } catch {}
    }

    // Delete the remote branch (cleanup)
    try {
      this.exec(`git branch -D "${branch}"`, repoPath);
    } catch {}
  }

  /**
   * List existing worktrees for a repo.
   */
  listWorktrees(repoPath: string): string[] {
    try {
      const output = this.exec("git worktree list --porcelain", repoPath);
      return output
        .split("\n")
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.replace("worktree ", ""));
    } catch {
      return [];
    }
  }

  private getDefaultBranch(repoPath: string): string {
    try {
      const ref = this.exec(
        "git symbolic-ref refs/remotes/origin/HEAD",
        repoPath
      ).trim();
      return ref.replace("refs/remotes/origin/", "");
    } catch {
      // Fallback: try main, then master
      try {
        this.exec("git rev-parse --verify origin/main", repoPath);
        return "main";
      } catch {
        return "master";
      }
    }
  }

  private exec(cmd: string, cwd?: string): string {
    return execSync(cmd, {
      cwd,
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}
