/**
 * HTTP API + WebSocket server for real-time streaming.
 * Serves the web chat UI and provides REST + WS endpoints.
 */

import express from "express";
import { createServer } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import type { PiAgent, PiEvent } from "./pi-agent.js";
import { isSttEnabled, transcribe } from "./transcribe.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApi(agent: PiAgent, port: number) {
  const app = express();
  const server = createServer(app);
  app.use(express.json());

  // Serve static web UI
  app.use("/ui", express.static(join(__dirname, "../public")));

  // Redirect root to UI
  app.get("/", (_req, res) => res.redirect("/ui"));

  // Health check
  app.get("/health", (_req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Chat endpoint
  app.post("/api/chat", async (req, res) => {
    const { threadId = "default", message, source = "api", repoUrl, description } = req.body;

    if (!message || typeof message !== "string") {
      res.status(400).json({ error: "message (string) is required" });
      return;
    }

    try {
      const response = await agent.chat(threadId, message, source, { repoUrl, description });
      res.json(response);
    } catch (err: any) {
      console.error("[API] Error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // Setup a repo for a session
  app.post("/api/session/setup", async (req, res) => {
    const { threadId = "default", repoUrl, description = "work" } = req.body;

    if (!repoUrl || typeof repoUrl !== "string") {
      res.status(400).json({ error: "repoUrl (string) is required" });
      return;
    }

    try {
      await agent.setupSession(threadId, repoUrl, description, "api");
      res.json({ success: true });
    } catch (err: any) {
      console.error("[API] Setup error:", err);
      res.status(500).json({ error: err.message });
    }
  });

  // New session
  app.post("/api/session/new", async (req, res) => {
    const { threadId = "default" } = req.body;
    await agent.newSession(threadId);
    res.json({ success: true });
  });

  // List active sessions with details
  app.get("/api/sessions", (_req, res) => {
    res.json({ sessions: agent.getSessionInfo() });
  });

  // List active threads (backward compat)
  app.get("/api/threads", (_req, res) => {
    res.json({ threads: agent.getActiveThreads() });
  });

  // STT status — lets the web UI know whether to show the mic button
  app.get("/api/stt-status", (_req, res) => {
    res.json({ enabled: isSttEnabled() });
  });

  // --- WebSocket for real-time streaming ---
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    console.log("[WS] Client connected");

    // Subscribe to all pi events
    const handler = (event: PiEvent) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
      }
    };
    agent.on("pi_event", handler);

    // Handle incoming messages from web UI
    ws.on("message", async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.type === "chat") {
          const threadId = msg.threadId || "web-default";
          agent
            .chat(threadId, msg.message, "web", {
              repoUrl: msg.repoUrl,
              description: msg.description,
            })
            .catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    threadId,
                    source: "web",
                    timestamp: Date.now(),
                    type: "error",
                    data: { message: err.message },
                  })
                );
              }
            });
        }

        if (msg.type === "setup_repo") {
          const threadId = msg.threadId || "web-default";
          agent
            .setupSession(threadId, msg.repoUrl, msg.description || "work", "web")
            .then(() => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    threadId,
                    source: "web",
                    timestamp: Date.now(),
                    type: "repo_ready",
                    data: { repoUrl: msg.repoUrl },
                  })
                );
              }
            })
            .catch((err) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(
                  JSON.stringify({
                    threadId,
                    source: "web",
                    timestamp: Date.now(),
                    type: "error",
                    data: { message: err.message },
                  })
                );
              }
            });
        }

        if (msg.type === "voice") {
          const threadId = msg.threadId || "web-default";

          if (!isSttEnabled()) {
            ws.send(JSON.stringify({
              threadId, source: "web", timestamp: Date.now(),
              type: "error",
              data: { message: "Speech-to-text is not enabled (set STT_ENABLED=true)" },
            }));
            return;
          }

          try {
            const audioBuffer = Buffer.from(msg.audio, "base64");
            const format = msg.format || "audio/webm";

            // Notify client that transcription is in progress
            ws.send(JSON.stringify({
              threadId, source: "web", timestamp: Date.now(),
              type: "transcription_start", data: {},
            }));

            const text = await transcribe(audioBuffer, format);

            // Send transcription result back to client
            ws.send(JSON.stringify({
              threadId, source: "web", timestamp: Date.now(),
              type: "transcription_complete", data: { text },
            }));

            // Automatically send the transcribed text as a chat message
            agent
              .chat(threadId, text, "web")
              .catch((err) => {
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({
                    threadId, source: "web", timestamp: Date.now(),
                    type: "error", data: { message: err.message },
                  }));
                }
              });
          } catch (err: any) {
            ws.send(JSON.stringify({
              threadId, source: "web", timestamp: Date.now(),
              type: "error",
              data: { message: `Transcription failed: ${err.message}` },
            }));
          }
        }

        if (msg.type === "new_session") {
          await agent.newSession(msg.threadId || "web-default");
        }
      } catch (err: any) {
        console.error("[WS] Parse error:", err);
      }
    });

    ws.on("close", () => {
      agent.off("pi_event", handler);
      console.log("[WS] Client disconnected");
    });
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`[API] Listening on http://0.0.0.0:${port}`);
    console.log(`[API] Web UI at http://0.0.0.0:${port}/ui`);
  });

  return server;
}
