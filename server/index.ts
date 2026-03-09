/**
 * Standalone HTTP + WebSocket server for browser-based CodePilot.
 *
 * Replaces the VSCode extension host — serves the React webview
 * as a static site and bridges WebSocket connections to claude.exe.
 *
 * Usage:
 *   node dist/server.js [--port 3000] [--cwd /path/to/project] [--binary /path/to/claude.exe]
 */

import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { WebSocketServer, WebSocket } from "ws";
import { ClientBridge } from "./bridge";
import { McpServer } from "../src/mcp/mcp-server";

// ============================================================
// CLI argument parsing
// ============================================================

function parseArgs(): {
  port: number;
  cwd: string;
  binary: string;
  host: string;
} {
  const args = process.argv.slice(2);
  let port = parseInt(process.env.PORT || "3000");
  let cwd = process.env.CLAUDE_CWD || process.cwd();
  let binary = process.env.CLAUDE_BINARY || "";
  let host = process.env.HOST || "127.0.0.1";

  for (let i = 0; i < args.length; i++) {
    switch (args[i]) {
      case "--port":
      case "-p":
        port = parseInt(args[++i]);
        break;
      case "--cwd":
      case "-d":
        cwd = args[++i];
        break;
      case "--binary":
      case "-b":
        binary = args[++i];
        break;
      case "--host":
        host = args[++i];
        break;
    }
  }

  // Auto-detect binary if not specified
  if (!binary) {
    binary = findClaudeBinary();
  }

  return { port, cwd, binary, host };
}

/**
 * Find claude binary: check resources/native-binary, then PATH.
 */
function findClaudeBinary(): string {
  const isWin = process.platform === "win32";
  const binName = isWin ? "claude.exe" : "claude";

  // Check resources/native-binary relative to this script
  const candidates = [
    path.join(__dirname, "..", "resources", "native-binary", binName),
    path.join(__dirname, "..", "..", "resources", "native-binary", binName),
  ];

  // Also check sibling directories (e.g. anthropic.claude-code-*/resources/native-binary/)
  try {
    const parentDir = path.join(__dirname, "..", "..");
    const siblings = fs.readdirSync(parentDir);
    for (const sibling of siblings) {
      if (sibling.startsWith("anthropic.claude-code")) {
        candidates.push(
          path.join(parentDir, sibling, "resources", "native-binary", binName)
        );
      }
    }
  } catch {
    // Ignore readdir errors
  }

  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }

  // Check if claude is on PATH (try common install locations)
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    const p = path.join(dir, binName);
    if (fs.existsSync(p)) return p;
  }

  // Last resort: npm global
  const npmGlobal = isWin
    ? path.join(
        process.env.APPDATA || "",
        "npm",
        "node_modules",
        "@anthropic-ai",
        "claude-code",
        "resources",
        "native-binary",
        binName
      )
    : path.join("/usr", "local", "lib", "node_modules", "@anthropic-ai", "claude-code", "resources", "native-binary", binName);

  if (fs.existsSync(npmGlobal)) return npmGlobal;

  console.error(
    `Claude binary not found. Specify with --binary /path/to/${binName} or CLAUDE_BINARY env var.`
  );
  process.exit(1);
}

// ============================================================
// Static file MIME types
// ============================================================

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

// ============================================================
// HTML template for browser
// ============================================================

const HTML_TEMPLATE = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="/index.css">
  <title>CodePilot — Claude Code</title>
  <style>
    /* Default theme variables (VSCode dark theme fallbacks) */
    :root {
      --vscode-editor-background: #1e1e1e;
      --vscode-editor-foreground: #d4d4d4;
      --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --vscode-editor-font-family: "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace;
      --vscode-editor-font-size: 13px;
      --vscode-panel-border: rgba(128, 128, 128, 0.35);
      --vscode-widget-border: rgba(128, 128, 128, 0.2);
      --vscode-list-hoverBackground: rgba(255, 255, 255, 0.04);
      --vscode-editor-selectionBackground: rgba(38, 79, 120, 0.6);
      --vscode-button-background: #0e639c;
      --vscode-button-foreground: #ffffff;
      --vscode-button-hoverBackground: #1177bb;
      --vscode-button-secondaryBackground: #3a3d41;
      --vscode-button-secondaryForeground: #cccccc;
      --vscode-input-background: #3c3c3c;
      --vscode-input-foreground: #cccccc;
      --vscode-input-border: #3c3c3c;
      --vscode-badge-background: #4d4d4d;
      --vscode-badge-foreground: #ffffff;
      --vscode-textLink-foreground: #3794ff;
      --vscode-errorForeground: #f44336;
      --vscode-editorWarning-foreground: #ff9800;
      --vscode-charts-green: #22c55e;
      --vscode-descriptionForeground: #9e9e9e;
      --vscode-textCodeBlock-background: rgba(128, 128, 128, 0.15);
      --vscode-scrollbarSlider-background: rgba(121, 121, 121, 0.4);
      --vscode-scrollbarSlider-hoverBackground: rgba(100, 100, 100, 0.7);
      --vscode-diffEditor-insertedTextBackground: rgba(35, 134, 54, 0.2);
      --vscode-diffEditor-removedTextBackground: rgba(255, 0, 0, 0.2);
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    window.__CODEPILOT_CONFIG__ = {
      IS_SIDEBAR: false,
      IS_FULL_EDITOR: true,
      INITIAL_PROMPT: "",
      INITIAL_SESSION: "",
      WS_URL: "ws://" + location.host + "/ws",
    };
  </script>
  <script type="module" src="/index.js"></script>
</body>
</html>`;

// ============================================================
// Main
// ============================================================

async function main(): Promise<void> {
  const config = parseArgs();

  console.log("=== CodePilot Standalone Server ===");
  console.log(`  Binary: ${config.binary}`);
  console.log(`  CWD:    ${config.cwd}`);
  console.log(`  Port:   ${config.port}`);

  // Start MCP server for claude.exe IDE tool callbacks
  const mcpServer = new McpServer({
    workspaceFolders: [config.cwd],
  });
  const mcpPort = await mcpServer.start();
  console.log(`  MCP:    port ${mcpPort}`);

  // Static file directory
  const distDir = path.join(__dirname, "..", "dist", "webview");

  // HTTP server
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    // Serve HTML at root
    if (url.pathname === "/" || url.pathname === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(HTML_TEMPLATE);
      return;
    }

    // Serve static files from dist/webview/
    const safePath = path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    const filePath = path.join(distDir, safePath);

    // Prevent directory traversal
    if (!filePath.startsWith(distDir)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not Found");
        return;
      }

      const ext = path.extname(filePath);
      const mime = MIME[ext] || "application/octet-stream";
      res.writeHead(200, {
        "Content-Type": mime,
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  });

  // WebSocket server for browser clients
  const wss = new WebSocketServer({ server, path: "/ws" });
  const bridges = new Set<ClientBridge>();

  wss.on("connection", (ws) => {
    console.log("[Server] Browser client connected");
    const bridge = new ClientBridge(ws, config.binary, config.cwd, mcpPort);
    bridges.add(bridge);

    ws.on("close", () => {
      bridges.delete(bridge);
      console.log("[Server] Browser client disconnected");
    });
  });

  // Start listening
  server.listen(config.port, config.host, () => {
    console.log(`\n  Open in browser: http://${config.host}:${config.port}\n`);
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[Server] Shutting down...");
    for (const bridge of bridges) {
      bridge.dispose();
    }
    await mcpServer.stop();
    server.close();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Catch unhandled errors to prevent silent crashes
process.on("unhandledRejection", (err) => {
  console.error("[Server] Unhandled promise rejection:", err);
});
process.on("uncaughtException", (err) => {
  console.error("[Server] Uncaught exception:", err);
});

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
