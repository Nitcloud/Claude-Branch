/**
 * CLI Process Manager — spawns and manages claude.exe child processes.
 * Equivalent to the j_ class in the original extension.js.
 */

import * as cp from "child_process";
import * as path from "path";
import * as fs from "fs";
import * as vscode from "vscode";
import * as readline from "readline";
import type {
  CliInput,
  CliOutput,
  CliControlResponse,
} from "../types/cli-protocol";
import { logDebug, logError, log } from "../utils/logger";

export interface SpawnOptions {
  /** Working directory */
  cwd: string;
  /** Model to use */
  model?: string;
  /** Permission mode */
  permissionMode?: string;
  /** Thinking level */
  thinkingLevel?: string;
  /** Session to resume */
  resumeSessionId?: string;
  /** Continue last session */
  continue?: boolean;
  /** Max conversation turns */
  maxTurns?: number;
  /** Include partial streaming messages */
  includePartialMessages?: boolean;
  /** MCP config JSON */
  mcpConfig?: string;
  /** Additional directories */
  addDirs?: string[];
  /** Agent name */
  agent?: string;
  /** Session ID override */
  sessionId?: string;
  /** MCP SSE port */
  ssePort?: number;
  /** Callback for stderr output */
  onStderr?: (data: string) => void;
  /** Callback for process exit */
  onExit?: (code: number | null) => void;
  /** Environment variable overrides */
  env?: Record<string, string>;
}

export interface CliProcess {
  /** Write a message to CLI stdin */
  write(msg: CliInput): void;
  /** Read messages from CLI stdout (async iterator) */
  messages(): AsyncIterable<CliOutput>;
  /** Kill the process */
  kill(): void;
  /** Send SIGINT / interrupt */
  interrupt(): void;
  /** Whether the process is alive */
  readonly alive: boolean;
  /** The underlying ChildProcess */
  readonly process: cp.ChildProcess;
}

/**
 * Find the claude binary path.
 * Priority:
 * 1. resources/native-binary/claude[.exe]
 * 2. settings claudeProcessWrapper
 */
export function findClaudeBinary(extensionPath: string): string {
  const isWin = process.platform === "win32";
  const binName = isWin ? "claude.exe" : "claude";

  // Try native-binary directory
  const nativeBin = path.join(
    extensionPath,
    "resources",
    "native-binary",
    binName
  );
  if (fs.existsSync(nativeBin)) {
    return nativeBin;
  }

  // Try platform-specific path
  const arch = process.arch;
  const platform = process.platform;
  const platformBin = path.join(
    extensionPath,
    "resources",
    "native-binaries",
    `${platform}-${arch}`,
    binName
  );
  if (fs.existsSync(platformBin)) {
    return platformBin;
  }

  // Windows ARM64 fallback to x64
  if (isWin && arch === "arm64") {
    const x64Bin = path.join(
      extensionPath,
      "resources",
      "native-binaries",
      "win32-x64",
      binName
    );
    if (fs.existsSync(x64Bin)) {
      return x64Bin;
    }
  }

  throw new Error(
    `Claude binary not found. Searched: ${nativeBin}, ${platformBin}`
  );
}

/**
 * Get the path to the original Claude Code extension's binary.
 * This allows reusing the binary from an installed Claude Code extension.
 */
export function findClaudeBinaryFromInstalledExtension(): string | undefined {
  const ext = vscode.extensions.getExtension("anthropic.claude-code");
  if (ext) {
    const isWin = process.platform === "win32";
    const binName = isWin ? "claude.exe" : "claude";
    const binPath = path.join(
      ext.extensionPath,
      "resources",
      "native-binary",
      binName
    );
    if (fs.existsSync(binPath)) {
      return binPath;
    }
  }
  return undefined;
}

/**
 * Spawn a claude.exe process and return a CliProcess handle.
 */
export function spawnClaude(
  binaryPath: string,
  options: SpawnOptions
): CliProcess {
  const args = buildArgs(options);
  const env = buildEnv(options);

  log(`Spawning CLI: ${binaryPath} ${args.join(" ")}`);
  logDebug(`CWD: ${options.cwd}`);
  logDebug(`ENV overrides: ${JSON.stringify(env)}`);

  // Build clean env: delete keys that cause "nested session" errors
  const cleanEnv = { ...process.env, ...env };
  delete cleanEnv.CLAUDECODE;
  delete cleanEnv.NODE_OPTIONS;
  delete cleanEnv.DEBUG;

  const proc = cp.spawn(binaryPath, args, {
    cwd: options.cwd,
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let alive = true;

  // Handle stderr
  if (proc.stderr && options.onStderr) {
    proc.stderr.on("data", (chunk: Buffer) => {
      options.onStderr!(chunk.toString("utf-8"));
    });
  }

  // Handle exit
  proc.on("exit", (code) => {
    alive = false;
    log(`CLI process exited with code ${code}`);
    options.onExit?.(code);
  });

  proc.on("error", (err) => {
    alive = false;
    logError("CLI process error", err);
  });

  // Create message reader
  const rl = readline.createInterface({
    input: proc.stdout!,
    crlfDelay: Infinity,
  });

  const messageIterator = createMessageIterator(rl);

  return {
    write(msg: CliInput): void {
      if (!alive || !proc.stdin || proc.stdin.destroyed) {
        logError("Cannot write to CLI: process not alive or stdin closed");
        return;
      }
      const line = JSON.stringify(msg) + "\n";
      proc.stdin.write(line, "utf-8");
    },

    messages(): AsyncIterable<CliOutput> {
      return messageIterator;
    },

    kill(): void {
      if (alive) {
        proc.kill();
        alive = false;
      }
    },

    interrupt(): void {
      if (alive) {
        // On Windows, we can't send SIGINT directly, so we write a special message
        if (process.platform === "win32") {
          // Send an interrupt by closing stdin (CLI interprets this as interrupt)
          // Actually, the original uses GenerateConsoleCtrlEvent or similar
          proc.kill("SIGINT");
        } else {
          proc.kill("SIGINT");
        }
      }
    },

    get alive() {
      return alive;
    },

    get process() {
      return proc;
    },
  };
}

function buildArgs(options: SpawnOptions): string[] {
  const args: string[] = [
    "--output-format",
    "stream-json",
    "--verbose",
    "--input-format",
    "stream-json",
    "--permission-prompt-tool",
    "stdio",
    "--include-partial-messages",
  ];

  if (options.model && options.model !== "default") {
    args.push("--model", options.model);
  }

  if (options.permissionMode) {
    args.push("--permission-mode", options.permissionMode);
  }

  if (options.thinkingLevel) {
    if (options.thinkingLevel === "disabled") {
      args.push("--thinking", "disabled");
    } else {
      args.push("--thinking", options.thinkingLevel);
    }
  }

  if (options.resumeSessionId) {
    args.push("--resume", options.resumeSessionId);
  } else if (options.continue) {
    args.push("--continue");
  }

  if (options.sessionId) {
    args.push("--session-id", options.sessionId);
  }

  if (options.maxTurns) {
    args.push("--max-turns", String(options.maxTurns));
  }

  if (options.mcpConfig) {
    args.push("--mcp-config", options.mcpConfig);
  }

  if (options.addDirs) {
    for (const dir of options.addDirs) {
      args.push("--add-dir", dir);
    }
  }

  if (options.agent) {
    args.push("--agent", options.agent);
  }

  return args;
}

function buildEnv(options: SpawnOptions): Record<string, string> {
  const env: Record<string, string> = {
    CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
    CLAUDE_AGENT_SDK_VERSION: "0.2.71",
    MCP_CONNECTION_NONBLOCKING: "true",
  };

  // Windows: claude.exe requires git-bash
  if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
    const bashPath = findGitBashPath();
    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
    }
  }

  if (options.ssePort) {
    env.CLAUDE_CODE_SSE_PORT = String(options.ssePort);
  }

  // Merge user-provided env vars
  if (options.env) {
    Object.assign(env, options.env);
  }

  // Add VSCode config environment variables
  const envVars =
    vscode.workspace
      .getConfiguration("claudeCode")
      .get<Array<{ name: string; value: string }>>("environmentVariables") ??
    [];
  for (const { name, value } of envVars) {
    env[name] = value;
  }

  return env;
}

async function* createMessageIterator(
  rl: readline.Interface
): AsyncIterable<CliOutput> {
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const parsed = JSON.parse(trimmed) as CliOutput;
      yield parsed;
    } catch {
      logDebug(`Failed to parse CLI output line: ${trimmed.slice(0, 200)}`);
    }
  }
}

/**
 * Send a control response back to the CLI process.
 */
export function sendControlResponse(
  cliProcess: CliProcess,
  requestId: string,
  response: unknown,
  isError = false
): void {
  const msg: CliControlResponse = {
    type: "control_response",
    response: isError
      ? { subtype: "error", request_id: requestId, error: String(response) }
      : { subtype: "success", request_id: requestId, response },
  };
  cliProcess.write(msg);
}

/**
 * Find git-bash on Windows.
 */
function findGitBashPath(): string | undefined {
  const candidates: string[] = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    path.join(
      process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || "", "AppData", "Local"),
      "Programs", "Git", "bin", "bash.exe"
    ),
  ];

  const pathEnv = process.env.PATH || process.env.Path || "";
  for (const dir of pathEnv.split(";")) {
    const lower = dir.toLowerCase();
    if (!lower.includes("git")) continue;

    const direct = path.join(dir, "bash.exe");
    if (fs.existsSync(direct)) {
      candidates.unshift(direct);
    }

    // Derive Git root and check Git\bin\bash.exe
    let gitRoot = dir;
    for (let i = 0; i < 3; i++) {
      const parent = path.dirname(gitRoot);
      if (parent === gitRoot) break;
      gitRoot = parent;
      const derived = path.join(gitRoot, "bin", "bash.exe");
      if (fs.existsSync(derived)) {
        candidates.unshift(derived);
        break;
      }
    }
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return undefined;
}
