/**
 * MCP WebSocket Server — provides IDE tools to claude.exe.
 *
 * claude.exe connects to this server via WebSocket and calls tools
 * like openFile, getDiagnostics, etc. using JSON-RPC protocol.
 *
 * NOTE: This module has NO vscode dependency — works in both
 * VSCode extension and standalone browser server modes.
 */

import { WebSocketServer, WebSocket } from "ws";
import * as http from "http";
import * as crypto from "crypto";
import * as path from "path";
import * as fs from "fs";
import { createToolHandler, type McpToolHandler } from "./mcp-tools";

export interface McpServerOptions {
  workspaceFolders: string[];
}

export class McpServer {
  private httpServer: http.Server | null = null;
  private wss: WebSocketServer | null = null;
  private port = 0;
  private authToken: string;
  private toolHandler: McpToolHandler;
  private connections = new Set<WebSocket>();

  constructor(private options: McpServerOptions) {
    this.authToken = crypto.randomBytes(32).toString("hex");
    this.toolHandler = createToolHandler(options);
  }

  /**
   * Start the MCP server on a random available port.
   * Returns the port number.
   */
  async start(): Promise<number> {
    this.httpServer = http.createServer();
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on("connection", (ws, req) => {
      const token = req.headers["x-claude-code-ide-authorization"];
      if (token !== this.authToken) {
        ws.close(4001, "Unauthorized");
        return;
      }
      this.handleConnection(ws);
    });

    return new Promise<number>((resolve, reject) => {
      this.httpServer!.listen(0, "127.0.0.1", () => {
        const addr = this.httpServer!.address();
        if (addr && typeof addr === "object") {
          this.port = addr.port;
          this.writeLockFile();
          console.log(`[MCP] Server listening on port ${this.port}`);
          resolve(this.port);
        } else {
          reject(new Error("Failed to bind MCP server"));
        }
      });

      this.httpServer!.on("error", reject);
    });
  }

  private handleConnection(ws: WebSocket): void {
    this.connections.add(ws);
    console.log("[MCP] Client connected");

    ws.on("message", async (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.jsonrpc !== "2.0") return;

        if (msg.method === "initialize") {
          // MCP initialization handshake
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                protocolVersion: "2024-11-05",
                capabilities: { tools: {} },
                serverInfo: {
                  name: "codepilot-ide",
                  version: "0.1.0",
                },
              },
            })
          );
          return;
        }

        if (msg.method === "notifications/initialized") {
          // Client acknowledged initialization — no response needed
          return;
        }

        if (msg.method === "tools/list") {
          const tools = this.toolHandler.listTools();
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: { tools },
            })
          );
          return;
        }

        if (msg.method === "tools/call") {
          const result = await this.toolHandler.callTool(
            msg.params?.name,
            msg.params?.arguments ?? {}
          );
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: msg.id,
              result: {
                content: [{ type: "text", text: JSON.stringify(result) }],
              },
            })
          );
          return;
        }

        // Unknown method
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: {
              code: -32601,
              message: `Method not found: ${msg.method}`,
            },
          })
        );
      } catch (err) {
        const errMsg =
          err instanceof Error ? err.message : "Internal MCP error";
        console.error(`[MCP] Error handling message:`, err);
        // Best-effort error response
        try {
          const parsed = JSON.parse(data.toString());
          ws.send(
            JSON.stringify({
              jsonrpc: "2.0",
              id: parsed.id,
              error: { code: -32603, message: errMsg },
            })
          );
        } catch {
          // Can't even parse the original message
        }
      }
    });

    ws.on("close", () => {
      this.connections.delete(ws);
      console.log("[MCP] Client disconnected");
    });

    ws.on("error", (err) => {
      console.error("[MCP] WebSocket error:", err);
      this.connections.delete(ws);
    });
  }

  private writeLockFile(): void {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        ".claude"
      );
    const ideDir = path.join(configDir, "ide");

    try {
      fs.mkdirSync(ideDir, { recursive: true });

      const lockData = {
        pid: process.pid,
        workspaceFolders: this.options.workspaceFolders,
        ideName: "codepilot",
        ideVersion: "0.1.0",
        transport: "ws",
      };

      fs.writeFileSync(
        path.join(ideDir, `${this.port}.lock`),
        JSON.stringify(lockData),
        "utf-8"
      );
    } catch (err) {
      console.error("[MCP] Failed to write lock file:", err);
    }
  }

  private removeLockFile(): void {
    const configDir =
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(
        process.env.HOME || process.env.USERPROFILE || "",
        ".claude"
      );
    const lockPath = path.join(configDir, "ide", `${this.port}.lock`);

    try {
      fs.unlinkSync(lockPath);
    } catch {
      // Already removed or never written
    }
  }

  getPort(): number {
    return this.port;
  }

  getAuthToken(): string {
    return this.authToken;
  }

  async stop(): Promise<void> {
    this.removeLockFile();

    for (const ws of this.connections) {
      ws.close();
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    if (this.httpServer) {
      this.httpServer.close();
      this.httpServer = null;
    }

    console.log("[MCP] Server stopped");
  }
}
