/**
 * Bridge — routes messages between WebSocket browser clients and
 * claude.exe CLI processes. Standalone replacement for client-server.ts
 * without any VSCode dependency.
 */

import { WebSocket } from "ws";
import * as cp from "child_process";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as crypto from "crypto";
import type {
  CliOutput,
  CliControlRequest,
  CliControlResponse,
  CliInput,
} from "../src/types/cli-protocol";
import type {
  WebviewToExtension,
  ExtensionToWebview,
  OutgoingRequest,
} from "../src/types/webview-protocol";
import type {
  CodepilotMeta,
  TaskInfo,
  BranchInfo,
  GraphNode,
  GraphBranch,
  BranchGraphData,
  SidebarTreeNode,
} from "../src/types/branch-graph";

// ============================================================
// Channel management
// ============================================================

interface Channel {
  channelId: string;
  proc: cp.ChildProcess;
  alive: boolean;
  abortController: AbortController;
  sessionId?: string;
}

// ============================================================
// ClientBridge — one per WebSocket connection
// ============================================================

export class ClientBridge {
  private channels = new Map<string, Channel>();
  private pendingRequests = new Map<
    string,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();

  constructor(
    private ws: WebSocket,
    private binaryPath: string,
    private cwd: string,
    private mcpPort: number
  ) {
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.onClientMessage(msg).catch((err) => {
          console.error("[Bridge] Unhandled async error in onClientMessage:", err);
        });
      } catch (err) {
        console.error("[Bridge] Failed to parse client message:", err);
      }
    });

    ws.on("close", () => {
      this.dispose();
    });
  }

  private sendToClient(message: ExtensionToWebview): void {
    try {
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({ type: "from-extension", message })
        );
      } else {
        console.warn(`[Bridge] WebSocket not open (state=${this.ws.readyState}), dropping message type=${message.type}`);
      }
    } catch (err) {
      console.error("[Bridge] sendToClient error:", err);
    }
  }

  private async onClientMessage(msg: WebviewToExtension): Promise<void> {
    try {
      switch (msg.type) {
        case "launch_claude":
          await this.handleLaunch(msg);
          break;
        case "close_channel":
          this.removeChannel(msg.channelId);
          break;
        case "interrupt_claude":
          this.interruptChannel(msg.channelId);
          break;
        case "io_message":
          this.handleIoMessage(msg);
          break;
        case "request":
          await this.handleRequest(msg);
          break;
        case "response":
          this.handleResponse(msg);
          break;
        case "cancel_request":
          this.handleCancelRequest(msg);
          break;
        default:
          console.log(
            `[Bridge] Unhandled message type: ${(msg as { type: string }).type}`
          );
      }
    } catch (err) {
      console.error("[Bridge] Error handling message:", err);
    }
  }

  // ============================================================
  // Launch CLI process
  // ============================================================

  private async handleLaunch(msg: {
    channelId: string;
    resume?: string;
    cwd?: string;
    model?: string;
    permissionMode?: string;
    thinkingLevel?: string;
    sessionId?: string;
    agent?: string;
    initialPrompt?: string;
    skipReplay?: boolean;
  }): Promise<void> {
    const cwd = msg.cwd || this.cwd;

    if (!fs.existsSync(this.binaryPath)) {
      this.sendToClient({
        type: "close_channel",
        channelId: msg.channelId,
        error: `Claude binary not found at: ${this.binaryPath}`,
      });
      return;
    }

    // If --resume is requested, verify the session file exists and has content.
    // Empty/missing files cause claude.exe to block indefinitely.
    // Fall back to --session-id (start fresh with that ID) when file is absent.
    if (msg.resume) {
      const filepath = this.findSessionFile(msg.resume);
      if (!filepath) {
        console.log(`[Bridge] Session file not found for resume: ${msg.resume}, starting fresh`);
        msg.sessionId = msg.resume;
        msg.resume = undefined;
      } else {
        try {
          const stat = fs.statSync(filepath);
          if (stat.size === 0) {
            console.log(`[Bridge] Session file empty for resume: ${msg.resume}, deleting and starting fresh`);
            // Delete the empty file so claude.exe won't reject the session ID as "already in use"
            try { fs.unlinkSync(filepath); } catch { /* ignore */ }
            msg.sessionId = msg.resume;
            msg.resume = undefined;
          }
        } catch {
          msg.sessionId = msg.resume;
          msg.resume = undefined;
        }
      }
    }

    // Claude CLI requires session IDs to be valid UUIDs.
    // Handle non-UUID resume IDs by renaming the file to a new UUID.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (msg.resume && !UUID_RE.test(msg.resume)) {
      const newId = crypto.randomUUID();
      console.log(`[Bridge] Non-UUID resume "${msg.resume}" → remapping to UUID: ${newId}`);
      const oldFile = this.findSessionFile(msg.resume);
      if (oldFile) {
        const newFile = path.join(path.dirname(oldFile), `${newId}.jsonl`);
        try {
          fs.copyFileSync(oldFile, newFile);
          // Update meta references
          await this.remapSessionId(msg.resume, newId);
          msg.resume = newId;
        } catch (err) {
          console.error(`[Bridge] Failed to remap session file:`, err);
          // Fall back to fresh session
          msg.sessionId = newId;
          msg.resume = undefined;
        }
      } else {
        msg.sessionId = newId;
        msg.resume = undefined;
      }
    }

    if (msg.sessionId && !UUID_RE.test(msg.sessionId)) {
      const newId = crypto.randomUUID();
      console.log(`[Bridge] Non-UUID sessionId "${msg.sessionId}" → using fresh UUID: ${newId}`);
      msg.sessionId = newId;
    }

    const args = this.buildArgs(msg);
    const env = this.buildEnv();

    console.log(`[Bridge] Spawning: ${this.binaryPath} ${args.join(" ")}`);
    console.log(`[Bridge] CWD: ${cwd}`);

    // Build clean env: merge process.env + our overrides, then delete blocked keys
    const cleanEnv: Record<string, string | undefined> = { ...process.env, ...env };
    // Must DELETE (not empty) CLAUDECODE — claude.exe checks key existence
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.NODE_OPTIONS;
    delete cleanEnv.DEBUG;

    const proc = cp.spawn(this.binaryPath, args, {
      cwd,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    const channel: Channel = {
      channelId: msg.channelId,
      proc,
      alive: true,
      abortController: new AbortController(),
      sessionId: msg.sessionId,
    };

    this.channels.set(msg.channelId, channel);

    // Handle stderr — log for debugging
    proc.stderr?.on("data", (chunk: Buffer) => {
      console.log(`[CLI stderr] ${chunk.toString("utf-8").trim()}`);
    });

    // Handle exit
    proc.on("exit", (code, signal) => {
      channel.alive = false;
      console.log(`[Bridge] CLI exited with code ${code}, signal ${signal}`);
      // code === null means killed by signal; code === 0 means clean exit.
      // Only treat non-zero numeric exit codes as errors.
      const isError = typeof code === "number" && code !== 0;
      this.sendToClient({
        type: "close_channel",
        channelId: msg.channelId,
        error: isError ? `CLI exited with code ${code}` : undefined,
      });
      this.channels.delete(msg.channelId);
    });

    proc.on("error", (err) => {
      channel.alive = false;
      console.error("[Bridge] CLI process error:", err);
    });

    // Start reading stdout
    this.readCliMessages(msg.channelId, channel);

    // claude.exe doesn't emit system init until it receives stdin input.
    // Tell the browser the channel is ready; system init will arrive with
    // the first real user message.
    const sessionId = msg.resume || msg.sessionId || crypto.randomUUID();
    this.sendToClient({
      type: "io_message",
      channelId: msg.channelId,
      message: {
        type: "system",
        subtype: "init",
        session_id: sessionId,
        model: "default",
        cwd: cwd,
        tools: [],
        mcp_servers: [],
        permissionMode: "default",
        claude_code_version: "2.1.71",
      },
      done: false,
    });

    // When resuming, replay historical messages from the JSONL file.
    // Skip if client already loaded history (lazy launch with skipReplay).
    if (msg.resume && !msg.skipReplay) {
      await this.replaySessionHistory(msg.channelId, msg.resume);
    }

    // If there's an initial prompt, send it to trigger real init + response
    if (msg.initialPrompt) {
      this.writeToChannel(msg.channelId, {
        type: "user",
        session_id: sessionId,
        message: {
          role: "user",
          content: [{ type: "text", text: msg.initialPrompt }],
        },
        parent_tool_use_id: null,
      });
    }
  }

  /**
   * Find a session JSONL file by ID across all project directories.
   */
  private findSessionFile(sessionId: string): string | null {
    const projectDirs = this.getClaudeProjectDirs();
    const filename = `${sessionId}.jsonl`;

    for (const dir of projectDirs) {
      const filepath = path.join(dir, filename);
      if (fs.existsSync(filepath)) return filepath;
    }
    return null;
  }

  /**
   * Remap a non-UUID session ID to a new UUID in meta (tasks + branches).
   * Used when claude.exe requires UUID format but we have legacy IDs.
   */
  private async remapSessionId(oldId: string, newId: string): Promise<void> {
    const meta = await this.loadMeta();
    let changed = false;

    // Remap in tasks
    if (meta.tasks?.[oldId]) {
      meta.tasks[newId] = { ...meta.tasks[oldId], taskId: newId, mainSessionId: newId };
      delete meta.tasks[oldId];
      changed = true;
      // Also update taskOrder
      if (meta.taskOrder) {
        meta.taskOrder = meta.taskOrder.map((id: string) => (id === oldId ? newId : id));
      }
    }

    // Remap mainSessionId references in tasks
    if (meta.tasks) {
      for (const task of Object.values(meta.tasks)) {
        if (task.mainSessionId === oldId) {
          task.mainSessionId = newId;
          changed = true;
        }
      }
    }

    // Remap in branches
    if (meta.branches?.[oldId]) {
      meta.branches[newId] = meta.branches[oldId];
      delete meta.branches[oldId];
      changed = true;
    }

    // Remap parentSessionId references in branches
    if (meta.branches) {
      for (const branch of Object.values(meta.branches)) {
        if (branch.parentSessionId === oldId) {
          branch.parentSessionId = newId;
          changed = true;
        }
      }
    }

    // Remap in order
    if (meta.order) {
      meta.order = meta.order.map((id: string) => (id === oldId ? newId : id));
    }

    if (changed) {
      await this.saveMeta(meta);
      console.log(`[Bridge] Meta remapped: ${oldId} → ${newId}`);
    }
  }

  /**
   * Replay session history from JSONL file to the webview.
   * Sends a single replay_batch with the most recent messages.
   *
   * Optimizations:
   * 1. Filters thinking/redacted_thinking blocks (huge, not displayed)
   * 2. Filters tool_result-only user messages (rendered as null in UI)
   * 3. Truncates very large tool_result content strings
   * 4. Limits to last MAX_REPLAY messages to prevent browser freeze
   */
  private async replaySessionHistory(
    channelId: string,
    sessionId: string
  ): Promise<void> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) {
      console.log(`[Bridge] Session file not found for: ${sessionId}`);
      return;
    }

    console.log(`[Bridge] Replaying session history from: ${filepath}`);

    const MAX_TOOL_RESULT_LEN = 3000;

    try {
      const content = await fsp.readFile(filepath, "utf-8");
      const lines = content.split("\n");
      const allMessages: unknown[] = [];

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);
          const type = parsed.type;

          // Only replay user and assistant messages
          if (type !== "user" && type !== "assistant") continue;

          // Must have a message with content
          if (!parsed.message?.content) continue;

          // Normalize: CLI stores user messages with string content,
          // but the webview expects an array of content blocks.
          if (typeof parsed.message.content === "string") {
            parsed.message.content = [
              { type: "text", text: parsed.message.content },
            ];
          }

          if (type === "assistant" && Array.isArray(parsed.message.content)) {
            // Filter out thinking blocks (huge, not displayed)
            parsed.message.content = parsed.message.content.filter(
              (block: { type: string }) =>
                block.type !== "thinking" && block.type !== "redacted_thinking"
            );
            if (parsed.message.content.length === 0) continue;
          }

          if (type === "user" && Array.isArray(parsed.message.content)) {
            // Skip user messages that ONLY contain tool_result blocks.
            // These render as null in MessageBubble anyway.
            const hasVisibleContent = parsed.message.content.some(
              (block: { type: string }) => block.type !== "tool_result"
            );
            if (!hasVisibleContent) continue;
          }

          // Truncate very large tool_result content to keep payload small
          if (Array.isArray(parsed.message.content)) {
            for (const block of parsed.message.content) {
              if (block.type === "tool_result" && typeof block.content === "string") {
                if (block.content.length > MAX_TOOL_RESULT_LEN) {
                  block.content =
                    block.content.slice(0, MAX_TOOL_RESULT_LEN) +
                    `\n... (truncated, ${block.content.length} chars total)`;
                }
              }
            }
          }

          allMessages.push(parsed);
        } catch {
          // Skip malformed lines
        }
      }

      // Send in chunks of CHUNK_SIZE to avoid oversized WebSocket frames.
      // The webview accumulates silently and only renders on the last chunk.
      const CHUNK_SIZE = 200;
      const totalCount = allMessages.length;

      if (totalCount > 0) {
        for (let i = 0; i < totalCount; i += CHUNK_SIZE) {
          const chunk = allMessages.slice(i, i + CHUNK_SIZE);
          const isLast = i + CHUNK_SIZE >= totalCount;
          this.sendToClient({
            type: "replay_batch",
            channelId,
            messages: chunk,
            isLast,
            totalCount,
          } as import("../src/types/webview-protocol").ReplayBatchMessage);
        }
      }

      console.log(`[Bridge] Replayed ${totalCount} visible messages in ${Math.ceil(totalCount / CHUNK_SIZE)} chunks`);
    } catch (err) {
      console.error("[Bridge] Failed to replay session:", err);
    }
  }

  private buildArgs(msg: {
    model?: string;
    permissionMode?: string;
    thinkingLevel?: string;
    resume?: string;
    sessionId?: string;
    agent?: string;
  }): string[] {
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

    if (msg.model && msg.model !== "default") {
      args.push("--model", msg.model);
    }

    if (msg.permissionMode) {
      args.push("--permission-mode", msg.permissionMode);
    }

    if (msg.thinkingLevel) {
      args.push("--thinking", msg.thinkingLevel);
    }

    if (msg.resume) {
      args.push("--resume", msg.resume);
    }

    if (msg.sessionId) {
      args.push("--session-id", msg.sessionId);
    }

    if (msg.agent) {
      args.push("--agent", msg.agent);
    }

    return args;
  }

  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {
      CLAUDE_CODE_ENTRYPOINT: "claude-vscode",
      CLAUDE_AGENT_SDK_VERSION: "0.2.71",
      MCP_CONNECTION_NONBLOCKING: "true",
    };

    if (this.mcpPort > 0) {
      env.CLAUDE_CODE_SSE_PORT = String(this.mcpPort);
    }

    // Windows: claude.exe requires git-bash
    if (process.platform === "win32" && !process.env.CLAUDE_CODE_GIT_BASH_PATH) {
      const bashPath = findGitBash();
      if (bashPath) {
        env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      }
    }

    return env;
  }

  // ============================================================
  // CLI message reading
  // ============================================================

  private async readCliMessages(
    channelId: string,
    channel: Channel
  ): Promise<void> {
    const rl = readline.createInterface({
      input: channel.proc.stdout!,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        if (channel.abortController.signal.aborted) break;

        const trimmed = line.trim();
        if (!trimmed) continue;

        let message: CliOutput;
        try {
          message = JSON.parse(trimmed);
        } catch {
          continue;
        }

        switch (message.type) {
          case "keep_alive":
            break;

          case "control_request":
            await this.handleCliControlRequest(
              channelId,
              message as CliControlRequest
            );
            break;

          case "control_cancel_request":
            this.sendToClient({
              type: "cancel_request",
              targetRequestId: (message as { request_id: string }).request_id,
            });
            break;

          case "result":
            this.sendToClient({
              type: "io_message",
              channelId,
              message,
              done: true,
            });
            break;

          default:
            if (
              message.type !== "streamlined_text" &&
              message.type !== "streamlined_tool_use_summary"
            ) {
              this.sendToClient({
                type: "io_message",
                channelId,
                message,
                done: false,
              });
            }
            break;
        }
      }
    } catch (err) {
      if (!channel.abortController.signal.aborted) {
        console.error(
          `[Bridge] Error reading CLI messages for ${channelId}:`,
          err
        );
      }
    }
  }

  // ============================================================
  // Control requests (permissions)
  // ============================================================

  private async handleCliControlRequest(
    channelId: string,
    request: CliControlRequest
  ): Promise<void> {
    const channel = this.channels.get(channelId);
    if (!channel) return;

    if (request.tool_name !== undefined) {
      // Permission request — forward to browser for approval
      const webviewRequestId = `perm-${request.request_id}`;

      const result = await new Promise<{
        accepted: boolean;
        updatedInput?: Record<string, unknown>;
      }>((resolve) => {
        this.pendingRequests.set(webviewRequestId, {
          resolve: (v) =>
            resolve(v as { accepted: boolean; updatedInput?: Record<string, unknown> }),
          reject: () => resolve({ accepted: false }),
        });

        this.sendToClient({
          type: "request",
          channelId,
          requestId: webviewRequestId,
          request: {
            type: "tool_permission_request",
            toolName: request.tool_name!,
            toolInput: request.tool_input ?? {},
            suggestions: request.suggestions ?? [],
            description: request.description,
            requestId: webviewRequestId,
          },
        });
      });

      this.sendControlResponse(
        channel,
        request.request_id,
        result.accepted
          ? {
              behavior: "allow",
              updatedInput: result.updatedInput,
            }
          : {
              behavior: "deny",
              message:
                "The user doesn't want to proceed with this tool use. The tool use was rejected. STOP what you are doing and wait for the user to tell you how to proceed.",
            }
      );
    } else if (request.hook_event_name !== undefined) {
      // Hook callback — auto-succeed
      this.sendControlResponse(channel, request.request_id, {});
    } else if (request.mcp_server_name !== undefined) {
      // MCP message — auto-succeed
      this.sendControlResponse(channel, request.request_id, {});
    } else if (request.elicitation !== undefined) {
      // Elicitation — cancel
      this.sendControlResponse(channel, request.request_id, {
        action: "cancel",
      });
    } else {
      this.sendControlResponse(
        channel,
        request.request_id,
        "Unknown control request",
        true
      );
    }
  }

  private sendControlResponse(
    channel: Channel,
    requestId: string,
    response: unknown,
    isError = false
  ): void {
    if (!channel.alive || !channel.proc.stdin) return;

    const msg: CliControlResponse = {
      type: "control_response",
      response: isError
        ? { subtype: "error", request_id: requestId, error: String(response) }
        : { subtype: "success", request_id: requestId, response },
    };

    channel.proc.stdin.write(JSON.stringify(msg) + "\n", "utf-8");
  }

  // ============================================================
  // IO + Request handling
  // ============================================================

  private handleIoMessage(msg: {
    channelId: string;
    message: unknown;
  }): void {
    this.writeToChannel(msg.channelId, msg.message as CliInput);
  }

  private writeToChannel(channelId: string, msg: CliInput): void {
    const channel = this.channels.get(channelId);
    if (channel?.alive && channel.proc.stdin) {
      channel.proc.stdin.write(JSON.stringify(msg) + "\n", "utf-8");
    }
  }

  private async handleRequest(msg: {
    channelId?: string;
    requestId: string;
    request: OutgoingRequest;
  }): Promise<void> {
    const { requestId, request } = msg;
    const reqType = request?.type ?? "unknown";
    console.log(`[Bridge] >> Request ${requestId}: ${reqType}`);
    const t0 = Date.now();

    try {
      const result = await this.processRequest(request);
      console.log(`[Bridge] << Response ${requestId}: ${reqType} (${Date.now() - t0}ms)`);
      this.sendToClient({
        type: "response",
        requestId,
        response: result,
      } as ExtensionToWebview);
    } catch (err) {
      console.error(`[Bridge] !! Error ${requestId}: ${reqType} (${Date.now() - t0}ms):`, err);
      this.sendToClient({
        type: "response",
        requestId,
        response: {
          error: err instanceof Error ? err.message : "Internal error",
        },
      } as ExtensionToWebview);
    }
  }

  private async processRequest(request: OutgoingRequest): Promise<unknown> {
    switch (request.type) {
      case "init":
        return {
          workspaceFolders: [
            { name: path.basename(this.cwd), path: this.cwd },
          ],
          platform: process.platform,
          version: "0.1.0",
        };

      case "get_claude_state":
        return {
          isAuthenticated: true,
          model: "default",
        };

      case "get_current_selection":
        return null;

      case "list_files_request":
        return this.handleListFiles(
          (request as { pattern: string }).pattern
        );

      case "open_file":
        console.log(
          `[Bridge] open_file: ${(request as { filePath: string }).filePath}`
        );
        return { success: true };

      case "open_url": {
        const url = (request as { url: string }).url;
        console.log(`[Bridge] open_url: ${url}`);
        // In browser mode, send a message to client to open the URL
        return { success: true };
      }

      case "show_notification":
        console.log(
          `[Bridge] notification: ${(request as { message: string }).message}`
        );
        return {};

      case "rename_tab":
        return {};

      case "new_conversation_tab":
        return {};

      case "log_event":
        return {};

      case "open_output_panel":
        return {};

      case "list_sessions_request":
        return this.handleListSessions();

      case "delete_session":
        return this.handleDeleteSession(
          (request as { sessionId: string }).sessionId
        );

      case "rename_session":
        return this.handleRenameSession(
          (request as { sessionId: string; name: string }).sessionId,
          (request as { sessionId: string; name: string }).name
        );

      case "reorder_sessions":
        return this.handleReorderSessions(
          (request as { sessionIds: string[] }).sessionIds
        );

      case "set_permission_mode": {
        const mode = (request as { mode: string }).mode;
        console.log(`[Bridge] set_permission_mode: ${mode}`);
        // Notify all channels of the mode change via system status message
        for (const [channelId] of this.channels) {
          this.sendToClient({
            type: "io_message",
            channelId,
            message: {
              type: "system",
              subtype: "status",
              permissionMode: mode,
            } as CliOutput,
            done: false,
          });
        }
        return { success: true };
      }

      case "set_model": {
        const model = (request as { model: string }).model;
        console.log(`[Bridge] set_model: ${model}`);
        // Store for next session launch — can't change model mid-stream
        return { success: true };
      }

      case "set_thinking_level":
        return {};

      case "check_git_status":
        return {};

      case "get_asset_uris":
        return { uris: {} };

      // ── Branch Graph requests ──

      case "create_task":
        return this.handleCreateTask(
          (request as { taskName: string }).taskName
        );

      case "rename_task":
        return this.handleRenameTask(
          (request as { taskId: string; name: string }).taskId,
          (request as { taskId: string; name: string }).name
        );

      case "delete_task":
        return this.handleDeleteTask(
          (request as { taskId: string }).taskId
        );

      case "reorder_tasks":
        return this.handleReorderTasks(
          (request as { taskIds: string[] }).taskIds
        );

      case "create_branch":
        return this.handleCreateBranch(
          (request as { parentSessionId: string; forkIndex: number; branchName: string }).parentSessionId,
          (request as { parentSessionId: string; forkIndex: number; branchName: string }).forkIndex,
          (request as { parentSessionId: string; forkIndex: number; branchName: string }).branchName
        );

      case "merge_branch": {
        const mb = request as { branchSessionId: string; mergeSummary: string; fromMsgIndex: number; toMsgIndex: number };
        return this.handleMergeBranch(mb.branchSessionId, mb.mergeSummary, mb.fromMsgIndex, mb.toMsgIndex);
      }

      case "rename_branch":
        return this.handleRenameBranch(
          (request as { branchSessionId: string; name: string }).branchSessionId,
          (request as { branchSessionId: string; name: string }).name
        );

      case "delete_branch":
        return this.handleDeleteBranch(
          (request as { branchSessionId: string }).branchSessionId
        );

      case "fork_and_rewind":
        return this.handleForkAndRewind(
          (request as { sessionId: string; forkIndex: number; branchName: string }).sessionId,
          (request as { sessionId: string; forkIndex: number; branchName: string }).forkIndex,
          (request as { sessionId: string; forkIndex: number; branchName: string }).branchName
        );

      case "rollback_session":
        return this.handleRollbackSession(
          (request as { sessionId: string; targetIndex: number }).sessionId,
          (request as { sessionId: string; targetIndex: number }).targetIndex
        );

      case "delete_turn":
        return this.handleDeleteTurn(
          (request as { sessionId: string; targetIndex: number }).sessionId,
          (request as { sessionId: string; targetIndex: number }).targetIndex
        );

      case "get_turn_text":
        return this.handleGetTurnText(
          (request as { sessionId: string; messageIndex: number }).sessionId,
          (request as { sessionId: string; messageIndex: number }).messageIndex
        );

      case "get_branch_graph":
        return this.handleGetBranchGraph(
          (request as { taskId: string }).taskId
        );

      case "get_merge_preview": {
        const mp = request as { branchSessionId: string; fromMsgIndex?: number; toMsgIndex?: number };
        return this.handleGetMergePreview(mp.branchSessionId, mp.fromMsgIndex, mp.toMsgIndex);
      }

      case "generate_merge_summary": {
        const gs = request as { branchSessionId: string; fromMsgIndex: number; toMsgIndex: number };
        return this.handleGenerateMergeSummary(gs.branchSessionId, gs.fromMsgIndex, gs.toMsgIndex);
      }

      case "get_sidebar_tree":
        return this.handleGetSidebarTree();

      case "get_session_messages":
        return this.handleGetSessionMessages(
          (request as { sessionId: string }).sessionId
        );

      case "move_session_to_task":
        return this.handleMoveSessionToTask(
          (request as { sessionId: string; targetTaskId: string }).sessionId,
          (request as { sessionId: string; targetTaskId: string }).targetTaskId
        );

      case "create_task_from_session":
        return this.handleCreateTaskFromSession(
          (request as { sessionId: string; taskName: string }).sessionId,
          (request as { sessionId: string; taskName: string }).taskName
        );

      case "import_session_to_task":
        return this.handleImportSessionToTask(
          (request as { sessionId: string; targetTaskId: string; branchName: string }).sessionId,
          (request as { sessionId: string; targetTaskId: string; branchName: string }).targetTaskId,
          (request as { sessionId: string; targetTaskId: string; branchName: string }).branchName
        );

      case "list_importable_sessions":
        return this.handleListImportableSessions();

      default:
        console.log(`[Bridge] Unhandled request: ${request.type}`);
        return {};
    }
  }

  /**
   * Get the Claude projects root directory (~/.claude/projects).
   */
  private getProjectsRoot(): string {
    return path.join(
      process.env.CLAUDE_CONFIG_DIR ||
        path.join(
          process.env.HOME || process.env.USERPROFILE || "",
          ".claude"
        ),
      "projects"
    );
  }

  /**
   * Find ALL Claude project directories for this workspace.
   * Searches current CWD and all parent directories so that sessions
   * from parent projects are also visible.
   * e.g. CWD = D:\Project\Code\Rust\CodePilot\extension
   *   → finds dirs for both "extension" and parent "CodePilot"
   */
  private getClaudeProjectDirs(): string[] {
    const projectsRoot = this.getProjectsRoot();
    if (!fs.existsSync(projectsRoot)) return [];

    let allEntries: string[];
    try {
      allEntries = fs.readdirSync(projectsRoot);
    } catch {
      return [];
    }

    const dirs: string[] = [];

    // Walk from CWD upward to drive root, check each level
    let current = path.resolve(this.cwd);
    const seen = new Set<string>();

    while (true) {
      const sanitized = current.replace(/[^a-zA-Z0-9]/g, "-");
      const lower = sanitized.toLowerCase();

      if (!seen.has(lower)) {
        seen.add(lower);

        // Try exact match
        const exactDir = path.join(projectsRoot, sanitized);
        if (fs.existsSync(exactDir)) {
          dirs.push(exactDir);
        } else {
          // Case-insensitive fallback
          for (const entry of allEntries) {
            if (entry.toLowerCase() === lower) {
              dirs.push(path.join(projectsRoot, entry));
              break;
            }
          }
        }
      }

      const parent = path.dirname(current);
      if (parent === current) break; // reached root
      current = parent;
    }

    return dirs;
  }

  /**
   * List all sessions from the current workspace and its parent projects.
   */
  private async handleListSessions(): Promise<{
    sessions: Array<{
      sessionId: string;
      title: string;
      lastModified: string;
      messageCount: number;
      sizeBytes: number;
    }>;
  }> {
    const projectDirs = this.getClaudeProjectDirs();
    if (projectDirs.length === 0) {
      console.log(`[Bridge] No Claude project dirs found for: ${this.cwd}`);
      return { sessions: [] };
    }

    console.log(`[Bridge] Reading sessions from ${projectDirs.length} project dir(s):`);
    projectDirs.forEach((d) => console.log(`  ${d}`));

    const sessions: Array<{
      sessionId: string;
      title: string;
      lastModified: string;
      messageCount: number;
      sizeBytes: number;
    }> = [];
    const seenIds = new Set<string>();

    for (const projectDir of projectDirs) {
      try {
        const entries = await fsp.readdir(projectDir, { withFileTypes: true });

        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;

          const sessionId = entry.name.replace(".jsonl", "");
          if (seenIds.has(sessionId)) continue;
          seenIds.add(sessionId);

          const filepath = path.join(projectDir, entry.name);
          const stat = await fsp.stat(filepath);
          if (stat.size === 0) continue;

          // Extract title and message count
          const { title, messageCount } = await this.extractSessionMeta(filepath, stat.size);

          // Skip empty sessions (placeholder files with no actual messages)
          if (messageCount === 0 && stat.size < 1000) continue;

          sessions.push({
            sessionId,
            title,
            lastModified: stat.mtime.toISOString(),
            messageCount,
            sizeBytes: stat.size,
          });
        }
      } catch (err) {
        console.error(`[Bridge] Failed to read ${projectDir}:`, err);
      }
    }

    // Apply custom titles and ordering from meta
    const meta = await this.loadMeta();
    if (meta.titles) {
      for (const session of sessions) {
        if (meta.titles[session.sessionId]) {
          session.title = meta.titles[session.sessionId];
        }
      }
    }

    // Apply custom order if present, otherwise sort by most recent
    if (meta.order && meta.order.length > 0) {
      const orderMap = new Map(meta.order.map((id, idx) => [id, idx]));
      sessions.sort((a, b) => {
        const oa = orderMap.get(a.sessionId);
        const ob = orderMap.get(b.sessionId);
        // Sessions in order come first, then unordered by date
        if (oa !== undefined && ob !== undefined) return oa - ob;
        if (oa !== undefined) return -1;
        if (ob !== undefined) return 1;
        return (
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime()
        );
      });
    } else {
      sessions.sort(
        (a, b) =>
          new Date(b.lastModified).getTime() -
          new Date(a.lastModified).getTime()
      );
    }

    console.log(`[Bridge] Found ${sessions.length} sessions total`);
    return { sessions };
  }

  /**
   * Extract title from a session JSONL file.
   * Only reads the first ~8KB to find the first user message.
   * Message count is estimated from file size for large files.
   */
  private async extractSessionMeta(
    filepath: string,
    sizeBytes: number
  ): Promise<{ title: string; messageCount: number }> {
    let title = "";
    let messageCount = 0;

    try {
      // For title, only read first 8KB — the first user message is always near the top
      const fd = await fsp.open(filepath, "r");
      const readSize = Math.min(sizeBytes, 8192);
      const buf = Buffer.alloc(readSize);
      await fd.read(buf, 0, readSize, 0);
      await fd.close();

      const head = buf.toString("utf-8");
      const headLines = head.split("\n");

      for (const line of headLines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        try {
          const parsed = JSON.parse(trimmed);

          if (parsed.type === "user" && parsed.message?.content) {
            const content = parsed.message.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block.type === "text" && block.text) {
                  title = stripSystemTags(block.text).slice(0, 120);
                  if (title) break;
                }
              }
            } else if (typeof content === "string") {
              title = stripSystemTags(content).slice(0, 120);
            }
            if (title) break;
          }
        } catch {
          // Skip incomplete/malformed lines
        }
      }

      // For message count: read full file only for small files (<100KB)
      // For larger files, estimate from size (~2KB per message pair avg)
      if (sizeBytes < 100_000) {
        const content = await fsp.readFile(filepath, "utf-8");
        const lines = content.split("\n");
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            if (parsed.type === "user" || parsed.type === "assistant") {
              messageCount++;
            }
          } catch {
            // Skip
          }
        }
      } else {
        // Rough estimate for large files
        messageCount = Math.max(1, Math.round(sizeBytes / 2048));
      }
    } catch {
      // Ignore read errors
    }

    return { title: title || "Untitled session", messageCount };
  }

  /**
   * Delete a session JSONL file from disk.
   */
  private async handleDeleteSession(
    sessionId: string
  ): Promise<{ success: boolean }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) {
      console.log(`[Bridge] Delete: session file not found: ${sessionId}`);
      return { success: false };
    }

    try {
      await fsp.unlink(filepath);
      // Also delete companion directory if it exists (e.g. task snapshots)
      const companionDir = filepath.replace(".jsonl", "");
      try {
        const stat = await fsp.stat(companionDir);
        if (stat.isDirectory()) {
          await fsp.rm(companionDir, { recursive: true });
        }
      } catch {
        // No companion dir, that's fine
      }
      // Remove from custom order
      await this.removeFromOrder(sessionId);
      console.log(`[Bridge] Deleted session: ${sessionId}`);
      return { success: true };
    } catch (err) {
      console.error(`[Bridge] Failed to delete session: ${sessionId}`, err);
      return { success: false };
    }
  }

  /**
   * Rename a session by writing a custom title to a metadata sidecar file.
   * We store renames in ~/.claude/projects/.codepilot-meta.json
   */
  private async handleRenameSession(
    sessionId: string,
    name: string
  ): Promise<{ success: boolean }> {
    try {
      const meta = await this.loadMeta();
      if (!meta.titles) meta.titles = {};
      meta.titles[sessionId] = name;
      await this.saveMeta(meta);
      console.log(`[Bridge] Renamed session ${sessionId} → "${name}"`);
      return { success: true };
    } catch (err) {
      console.error(`[Bridge] Failed to rename session: ${sessionId}`, err);
      return { success: false };
    }
  }

  /**
   * Save a custom session ordering.
   */
  private async handleReorderSessions(
    sessionIds: string[]
  ): Promise<{ success: boolean }> {
    try {
      const meta = await this.loadMeta();
      meta.order = sessionIds;
      await this.saveMeta(meta);
      console.log(`[Bridge] Saved custom order: ${sessionIds.length} sessions`);
      return { success: true };
    } catch (err) {
      console.error("[Bridge] Failed to save session order:", err);
      return { success: false };
    }
  }

  // ============================================================
  // Session metadata sidecar file (.codepilot-meta.json)
  // ============================================================

  private getMetaFilePath(): string {
    const projectDirs = this.getClaudeProjectDirs();
    // Use the first (most specific) project dir for meta storage
    const dir = projectDirs[0] || path.join(this.getProjectsRoot(), "_default");
    return path.join(dir, ".codepilot-meta.json");
  }

  private async loadMeta(): Promise<CodepilotMeta> {
    try {
      const data = await fsp.readFile(this.getMetaFilePath(), "utf-8");
      return JSON.parse(data);
    } catch {
      return {};
    }
  }

  private async saveMeta(meta: CodepilotMeta): Promise<void> {
    const filepath = this.getMetaFilePath();
    await fsp.mkdir(path.dirname(filepath), { recursive: true });
    await fsp.writeFile(filepath, JSON.stringify(meta, null, 2), "utf-8");
  }

  private async removeFromOrder(sessionId: string): Promise<void> {
    try {
      const meta = await this.loadMeta();
      if (meta.order) {
        meta.order = meta.order.filter((id) => id !== sessionId);
        await this.saveMeta(meta);
      }
      if (meta.titles?.[sessionId]) {
        delete meta.titles[sessionId];
        await this.saveMeta(meta);
      }
    } catch {
      // Ignore
    }
  }

  private async handleListFiles(
    pattern: string
  ): Promise<{ files: string[] }> {
    // Simple glob-less file listing for standalone mode
    const files: string[] = [];
    try {
      const entries = fs.readdirSync(this.cwd, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile()) {
          files.push(entry.name);
        }
      }
    } catch {
      // Ignore errors
    }
    return { files: files.slice(0, 100) };
  }

  private handleResponse(msg: {
    requestId: string;
    response: unknown;
  }): void {
    const pending = this.pendingRequests.get(msg.requestId);
    if (pending) {
      this.pendingRequests.delete(msg.requestId);
      pending.resolve(msg.response);
    }
  }

  private handleCancelRequest(msg: { targetRequestId: string }): void {
    const pending = this.pendingRequests.get(msg.targetRequestId);
    if (pending) {
      this.pendingRequests.delete(msg.targetRequestId);
      pending.reject(new Error("Request cancelled"));
    }
  }

  // ============================================================
  // Branch Graph — Task CRUD
  // ============================================================

  /**
   * Create a new Task with an empty main-line session.
   */
  private async handleCreateTask(
    taskName: string
  ): Promise<{ taskId: string; mainSessionId: string }> {
    const mainSessionId = crypto.randomUUID();
    const taskId = mainSessionId;

    const meta = await this.loadMeta();
    if (!meta.tasks) meta.tasks = {};
    if (!meta.taskOrder) meta.taskOrder = [];

    const task: TaskInfo = {
      taskId,
      taskName,
      mainSessionId,
      createdAt: new Date().toISOString(),
    };
    meta.tasks[taskId] = task;
    meta.taskOrder.push(taskId);

    // Don't create a JSONL file — claude.exe will create it on first message.
    // Creating an empty file causes "Session ID already in use" errors.

    await this.saveMeta(meta);
    console.log(`[Bridge] Created task "${taskName}" (${taskId})`);
    return { taskId, mainSessionId };
  }

  private async handleRenameTask(
    taskId: string,
    name: string
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    if (meta.tasks?.[taskId]) {
      meta.tasks[taskId].taskName = name;
      await this.saveMeta(meta);
      return { success: true };
    }
    return { success: false };
  }

  private async handleRenameBranch(
    branchSessionId: string,
    name: string
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    if (meta.branches?.[branchSessionId]) {
      meta.branches[branchSessionId].branchName = name;
      await this.saveMeta(meta);
      console.log(`[Bridge] Renamed branch ${branchSessionId} to "${name}"`);
      return { success: true };
    }
    // Check if this is a main branch (mainSessionId of a task)
    if (meta.tasks) {
      for (const task of Object.values(meta.tasks)) {
        if (task.mainSessionId === branchSessionId) {
          task.mainBranchName = name;
          await this.saveMeta(meta);
          console.log(`[Bridge] Renamed main branch of task ${task.taskId} to "${name}"`);
          return { success: true };
        }
      }
    }
    return { success: false };
  }

  private async handleDeleteTask(
    taskId: string
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    const task = meta.tasks?.[taskId];
    if (!task) return { success: false };

    // Collect all session IDs belonging to this task
    const sessionsToDelete = [task.mainSessionId];
    if (meta.branches) {
      for (const [sessionId, branch] of Object.entries(meta.branches)) {
        if (this.isBranchOfTask(sessionId, taskId, meta)) {
          sessionsToDelete.push(sessionId);
        }
      }
    }

    // Kill any active CLI processes for these sessions
    for (const [, channel] of this.channels) {
      if (channel.sessionId && sessionsToDelete.includes(channel.sessionId)) {
        this.removeChannel(channel.channelId);
      }
    }

    // Delete JSONL files
    for (const sid of sessionsToDelete) {
      const filepath = this.findSessionFile(sid);
      if (filepath) {
        try { await fsp.unlink(filepath); } catch { /* ignore */ }
      }
      // Remove branch entry
      if (meta.branches?.[sid]) delete meta.branches[sid];
    }

    // Remove task entry
    delete meta.tasks[taskId];
    if (meta.taskOrder) {
      meta.taskOrder = meta.taskOrder.filter((id) => id !== taskId);
    }

    await this.saveMeta(meta);
    console.log(`[Bridge] Deleted task ${taskId} (${sessionsToDelete.length} sessions)`);
    return { success: true };
  }

  private async handleReorderTasks(
    taskIds: string[]
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    meta.taskOrder = taskIds;
    await this.saveMeta(meta);
    return { success: true };
  }

  /**
   * Check if a session belongs to a given task (follows parentSessionId chain).
   */
  private isBranchOfTask(
    sessionId: string,
    taskId: string,
    meta: CodepilotMeta
  ): boolean {
    const task = meta.tasks?.[taskId];
    if (!task) return false;
    if (sessionId === task.mainSessionId) return true;

    let current = sessionId;
    const visited = new Set<string>();
    while (meta.branches?.[current]) {
      if (visited.has(current)) return false; // cycle guard
      visited.add(current);
      const parent = meta.branches[current].parentSessionId;
      if (parent === task.mainSessionId) return true;
      current = parent;
    }
    return false;
  }

  // ============================================================
  // Branch Graph — Branch CRUD
  // ============================================================

  /**
   * Create a branch by copying the parent JSONL up to forkIndex.
   * forkIndex counts user+assistant message pairs (0-based).
   */
  private async handleCreateBranch(
    parentSessionId: string,
    forkIndex: number,
    branchName: string
  ): Promise<{ branchSessionId: string }> {
    const parentFile = this.findSessionFile(parentSessionId);
    if (!parentFile) throw new Error(`Parent session not found: ${parentSessionId}`);

    const branchSessionId = crypto.randomUUID();

    // Read parent JSONL and truncate at forkIndex
    const truncated = await this.truncateJsonlAtIndex(parentFile, forkIndex);

    // Write branch JSONL
    const projectDirs = this.getClaudeProjectDirs();
    const branchFile = path.join(projectDirs[0], `${branchSessionId}.jsonl`);
    await fsp.writeFile(branchFile, truncated, "utf-8");

    // Calculate depth
    const meta = await this.loadMeta();
    let depth = 1;
    if (meta.branches?.[parentSessionId]) {
      depth = meta.branches[parentSessionId].depth + 1;
    }

    if (!meta.branches) meta.branches = {};
    meta.branches[branchSessionId] = {
      parentSessionId,
      forkIndex,
      branchName,
      createdAt: new Date().toISOString(),
      status: "active",
      depth,
    };

    await this.saveMeta(meta);
    console.log(`[Bridge] Created branch "${branchName}" (${branchSessionId}) from ${parentSessionId}@${forkIndex}`);
    return { branchSessionId };
  }

  /**
   * Merge a branch back into its parent by injecting a summary message.
   * Supports incremental merges: each merge covers [fromMsgIndex, toMsgIndex].
   */
  private async handleMergeBranch(
    branchSessionId: string,
    mergeSummary: string,
    fromMsgIndex: number,
    toMsgIndex: number
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    const branch = meta.branches?.[branchSessionId];
    if (!branch) throw new Error(`Branch not found: ${branchSessionId}`);

    const parentFile = this.findSessionFile(branch.parentSessionId);
    if (!parentFile) throw new Error(`Parent session not found: ${branch.parentSessionId}`);

    // Count current messages in parent to determine injection position
    const parentContent = await fsp.readFile(parentFile, "utf-8");
    const parentLines = parentContent.split("\n").filter((l) => l.trim());
    let parentMergeIndex = 0;
    for (const line of parentLines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "user" || parsed.type === "assistant") parentMergeIndex++;
      } catch { /* skip */ }
    }

    // Inject merge summary as a synthetic assistant message
    const mergeId = `merge-${branchSessionId}-${fromMsgIndex}-${toMsgIndex}`;
    const rangeLabel = fromMsgIndex === 0 && toMsgIndex === fromMsgIndex
      ? `Turn #${toMsgIndex + 1}`
      : `Turns #${fromMsgIndex + 1}–#${toMsgIndex + 1}`;
    const mergeMessage = {
      type: "assistant",
      message: {
        id: mergeId,
        role: "assistant",
        model: "merge",
        content: [
          {
            type: "text",
            text: `[Branch Merge: ${branch.branchName} (${rangeLabel})]\n\n${mergeSummary}`,
          },
        ],
        stop_reason: "end_turn",
      },
    };
    await fsp.appendFile(parentFile, JSON.stringify(mergeMessage) + "\n", "utf-8");

    // Count total user messages in branch to decide status
    const branchFile = this.findSessionFile(branchSessionId);
    let totalBranchMsgCount = 0;
    if (branchFile) {
      const branchContent = await fsp.readFile(branchFile, "utf-8");
      for (const bl of branchContent.split("\n").filter((l) => l.trim())) {
        try {
          const p = JSON.parse(bl);
          if (p.type === "user" && p.message?.content) totalBranchMsgCount++;
        } catch { /* skip */ }
      }
    }

    // Append merge record to history
    if (!branch.mergeHistory) branch.mergeHistory = [];
    branch.mergeHistory.push({
      fromMsgIndex,
      toMsgIndex,
      summary: mergeSummary,
      parentMergeIndex,
      timestamp: new Date().toISOString(),
    });

    // Auto-mark as "merged" when all turns are covered
    if (toMsgIndex >= totalBranchMsgCount - 1) {
      branch.status = "merged";
    }

    await this.saveMeta(meta);

    console.log(`[Bridge] Merged branch "${branch.branchName}" turns ${fromMsgIndex}-${toMsgIndex} into ${branch.parentSessionId}`);
    return { success: true };
  }

  /**
   * Run claude.exe in one-shot mode (-p) for text generation.
   * Used for AI-powered merge summary generation.
   */
  private async runClaudeOneShot(prompt: string): Promise<string> {
    const env = this.buildEnv();
    const cleanEnv: Record<string, string | undefined> = { ...process.env, ...env };
    delete cleanEnv.CLAUDECODE;
    delete cleanEnv.NODE_OPTIONS;
    delete cleanEnv.DEBUG;

    const args = ["-p", "--output-format", "text"];
    const proc = cp.spawn(this.binaryPath, args, {
      cwd: this.cwd,
      env: cleanEnv,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    // Pass prompt via stdin to avoid command-line length limits
    proc.stdin!.write(prompt);
    proc.stdin!.end();

    return new Promise<string>((resolve, reject) => {
      let output = "";
      let stderr = "";
      proc.stdout!.on("data", (chunk: Buffer) => { output += chunk.toString(); });
      proc.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on("exit", (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`claude.exe -p exited with code ${code}: ${stderr.slice(0, 500)}`));
        }
      });
      proc.on("error", reject);
    });
  }

  /**
   * Generate an AI summary for a range of branch messages.
   */
  private async handleGenerateMergeSummary(
    branchSessionId: string,
    fromMsgIndex: number,
    toMsgIndex: number
  ): Promise<{ summary: string }> {
    const meta = await this.loadMeta();
    const branch = meta.branches?.[branchSessionId];
    if (!branch) throw new Error(`Branch not found: ${branchSessionId}`);

    const filepath = this.findSessionFile(branchSessionId);
    if (!filepath) throw new Error(`Branch session file not found: ${branchSessionId}`);

    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    // Extract user+assistant messages in the requested range
    let userMsgIdx = -1;
    const rangeTexts: string[] = [];

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "user" && parsed.type !== "assistant") continue;

        if (parsed.type === "user" && parsed.message?.content) {
          userMsgIdx++;
        }

        if (userMsgIdx >= fromMsgIndex && userMsgIdx <= toMsgIndex) {
          const role = parsed.type === "user" ? "User" : "Assistant";
          const blocks = Array.isArray(parsed.message?.content)
            ? parsed.message.content
            : [];
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              rangeTexts.push(`[${role}]: ${b.text}`);
            }
          }
        }

        if (userMsgIdx > toMsgIndex) break;
      } catch { /* skip */ }
    }

    if (rangeTexts.length === 0) {
      return { summary: "(No content found in the specified range)" };
    }

    const conversationContent = rangeTexts.join("\n\n---\n\n");
    const prompt = `Please summarize the following conversation turns concisely in the same language as the conversation. Focus on key decisions, findings, conclusions, and actionable outcomes. Keep the summary structured and clear:\n\n${conversationContent}`;

    console.log(`[Bridge] Generating AI merge summary for branch "${branch.branchName}" turns ${fromMsgIndex}-${toMsgIndex} (${rangeTexts.length} blocks)`);

    try {
      const summary = await this.runClaudeOneShot(prompt);
      return { summary };
    } catch (err) {
      console.error("[Bridge] AI summary generation failed:", err);
      // Fallback: return truncated content
      const fallback = conversationContent.slice(0, 500);
      return {
        summary: `(AI summary failed, showing raw preview)\n\n${fallback}${conversationContent.length > 500 ? "..." : ""}`,
      };
    }
  }

  /**
   * Delete a branch — removes JSONL and updates metadata.
   */
  private async handleDeleteBranch(
    branchSessionId: string
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();
    const branch = meta.branches?.[branchSessionId];
    if (!branch) return { success: false };

    // Kill any active CLI process for this branch
    for (const [, channel] of this.channels) {
      if (channel.sessionId === branchSessionId) {
        this.removeChannel(channel.channelId);
      }
    }

    // Also delete any sub-branches of this branch
    const subBranches: string[] = [];
    if (meta.branches) {
      for (const [sid, b] of Object.entries(meta.branches)) {
        if (b.parentSessionId === branchSessionId) {
          subBranches.push(sid);
        }
      }
    }
    for (const sid of subBranches) {
      await this.handleDeleteBranch(sid);
    }

    // Delete JSONL file
    const filepath = this.findSessionFile(branchSessionId);
    if (filepath) {
      try { await fsp.unlink(filepath); } catch { /* ignore */ }
    }

    // Update metadata
    branch.status = "deleted";
    delete meta.branches![branchSessionId];
    await this.saveMeta(meta);

    console.log(`[Bridge] Deleted branch "${branch.branchName}" (${branchSessionId})`);
    return { success: true };
  }

  // ============================================================
  // Branch Graph — Rollback
  // ============================================================

  /**
   * Rollback a session to a specific message index.
   * Creates a .bak backup before truncating.
   */
  private async handleRollbackSession(
    sessionId: string,
    targetIndex: number
  ): Promise<{ success: boolean }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) throw new Error(`Session not found: ${sessionId}`);

    // Kill any active CLI process (will need re-resume)
    for (const [, channel] of this.channels) {
      if (channel.sessionId === sessionId) {
        this.removeChannel(channel.channelId);
      }
    }

    // Create backup
    const bakPath = filepath + `.bak.${Date.now()}`;
    await fsp.copyFile(filepath, bakPath);

    // Truncate at targetIndex
    const truncated = await this.truncateJsonlAtIndex(filepath, targetIndex);
    await fsp.writeFile(filepath, truncated, "utf-8");

    console.log(`[Bridge] Rolled back session ${sessionId} to index ${targetIndex} (backup: ${bakPath})`);
    return { success: true };
  }

  /**
   * Fork conversation AND rewind the current session to a given point.
   * 1. Create a branch (copy current session from forkIndex forward)
   * 2. Rollback the current session to forkIndex
   */
  private async handleForkAndRewind(
    sessionId: string,
    forkIndex: number,
    branchName: string
  ): Promise<{ branchSessionId: string }> {
    // 1. Create the branch first (saves current continuation)
    const branchResult = await this.handleCreateBranch(sessionId, forkIndex, branchName);

    // 2. Rollback the current session to the fork point
    await this.handleRollbackSession(sessionId, forkIndex);

    console.log(`[Bridge] Fork+Rewind: branched to ${branchResult.branchSessionId}, rolled back ${sessionId} to ${forkIndex}`);
    return { branchSessionId: branchResult.branchSessionId };
  }

  /**
   * Delete a single turn (user message + its following assistant messages)
   * from a session JSONL file. Creates a .bak backup first.
   */
  private async handleDeleteTurn(
    sessionId: string,
    targetIndex: number
  ): Promise<{ success: boolean }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) throw new Error(`Session not found: ${sessionId}`);

    // Kill any active CLI process
    for (const [, channel] of this.channels) {
      if (channel.sessionId === sessionId) {
        this.removeChannel(channel.channelId);
      }
    }

    // Create backup
    const bakPath = filepath + `.bak.${Date.now()}`;
    await fsp.copyFile(filepath, bakPath);

    // Remove the turn at targetIndex
    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n");
    const kept: string[] = [];
    let msgIndex = 0;
    let skipping = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        if (parsed.type === "user") {
          if (msgIndex === targetIndex) {
            // Start skipping this user message and following assistant lines
            skipping = true;
            msgIndex++;
            continue;
          }
          // Hit next user message — stop skipping
          skipping = false;
          msgIndex++;
        }

        if (skipping && parsed.type === "assistant") {
          // Skip assistant replies that belong to the deleted turn
          continue;
        }

        // Any non-user, non-assistant line while skipping (e.g. system) → stop skipping
        if (skipping && parsed.type !== "assistant") {
          skipping = false;
        }

        kept.push(trimmed);
      } catch {
        kept.push(trimmed);
      }
    }

    await fsp.writeFile(filepath, kept.join("\n") + "\n", "utf-8");
    console.log(`[Bridge] Deleted turn ${targetIndex} from session ${sessionId} (backup: ${bakPath})`);
    return { success: true };
  }

  // ============================================================
  // Branch Graph — Graph & Tree builders
  // ============================================================

  /**
   * Build the complete graph data for a task.
   * Each user message becomes a GraphNode; parent relationships
   * form the edges for SVG rendering.
   */
  private async handleGetBranchGraph(
    taskId: string
  ): Promise<{ graph: BranchGraphData }> {
    const meta = await this.loadMeta();
    const task = meta.tasks?.[taskId];
    if (!task) throw new Error(`Task not found: ${taskId}`);

    const nodes: GraphNode[] = [];
    const branches: GraphBranch[] = [];
    let nextId = 0;
    const mainBranchName = task.mainBranchName || "main";

    // Map: sessionId:messageIndex → nodeId (for parent linking)
    const nodeIdMap = new Map<string, number>();

    // 1. Build nodes for main session
    const mainResult = await this.buildSessionNodes(
      task.mainSessionId,
      mainBranchName,
      0,
      nextId,
      nodeIdMap
    );
    nodes.push(...mainResult.nodes);
    nextId += mainResult.nodes.length;
    branches.push({ sessionId: task.mainSessionId, name: mainBranchName, status: "active", depth: 0 });
    console.log(`[BranchGraph] Main session: ${mainResult.nodes.length} nodes`);

    // If main session is empty but has child branches, add a virtual root node
    // so that branches have a visual fork point in the graph
    const hasChildBranches = meta.branches && Object.entries(meta.branches)
      .some(([sid, b]) => b.status !== "deleted" && this.isBranchOfTask(sid, taskId, meta));
    let virtualRootId: number | null = null;
    if (mainResult.nodes.length === 0 && hasChildBranches) {
      const virtualRoot: GraphNode = {
        id: nextId,
        sessionId: task.mainSessionId,
        messageIndex: -1,
        displayMessageIndex: -1,
        messagePreview: task.taskName,
        aiReplyPreview: "",
        timestamp: task.createdAt || new Date().toISOString(),
        parentIds: [],
        branchName: mainBranchName,
        isForkPoint: true,
        isMergePoint: false,
        isCurrent: false,
      };
      nodes.push(virtualRoot);
      virtualRootId = nextId;
      // Map forkIndex 0 to this virtual root so branches connect to it
      nodeIdMap.set(`${task.mainSessionId}:0`, nextId);
      nextId++;
    }

    // 2. Build nodes for all branches of this task
    if (meta.branches) {
      // Sort branches by depth so parents are processed first
      const taskBranches = Object.entries(meta.branches)
        .filter(([sid]) => this.isBranchOfTask(sid, taskId, meta))
        .sort(([, a], [, b]) => a.depth - b.depth);

      for (const [branchSessionId, branchInfo] of taskBranches) {
        if (branchInfo.status === "deleted") continue;

        // Compute actual shared prefix count.
        // For new branches (correct truncation): totalUserMsgs >= forkIndex+1
        // For old branches (buggy truncation): totalUserMsgs < forkIndex+1
        const expectedForkCount = (branchInfo.forkIndex ?? 0) + 1;
        let sharedPrefixCount = expectedForkCount;
        const branchFile = this.findSessionFile(branchSessionId);
        if (branchFile) {
          const branchContent = await fsp.readFile(branchFile, "utf-8");
          const branchLines = branchContent.split("\n").filter((l) => l.trim());
          let totalUserMsgs = 0;
          for (const bl of branchLines) {
            try {
              const p = JSON.parse(bl);
              if (p.type === "user" && p.message?.content) totalUserMsgs++;
            } catch {}
          }

          // Detect legacy branches with corrupted truncation
          if (totalUserMsgs < expectedForkCount) {
            const parentFile = this.findSessionFile(branchInfo.parentSessionId);
            if (parentFile) {
              // Auto-repair: re-truncate from parent with correct logic
              console.log(`[Bridge] Repairing legacy branch ${branchSessionId}: had ${totalUserMsgs} user msgs, expected ${expectedForkCount}`);
              const correctPrefix = await this.truncateJsonlAtIndex(parentFile, branchInfo.forkIndex ?? 0);

              // Preserve any new content the user added after the fork
              // New messages have timestamps after branch creation
              const createdAt = branchInfo.createdAt;
              const newLines: string[] = [];
              if (createdAt) {
                for (const bl of branchLines) {
                  try {
                    const p = JSON.parse(bl);
                    if (p.timestamp && p.timestamp > createdAt) {
                      newLines.push(bl);
                    }
                  } catch {}
                }
              }

              let repairedContent = correctPrefix;
              if (newLines.length > 0) {
                repairedContent += newLines.join("\n") + "\n";
              }
              await fsp.writeFile(branchFile, repairedContent, "utf-8");

              // Recount after repair
              const repairedLines = repairedContent.split("\n").filter((l) => l.trim());
              totalUserMsgs = 0;
              for (const rl of repairedLines) {
                try {
                  const p = JSON.parse(rl);
                  if (p.type === "user" && p.message?.content) totalUserMsgs++;
                } catch {}
              }
              console.log(`[Bridge] Branch repaired: now ${totalUserMsgs} user msgs`);
            }
          }

          sharedPrefixCount = Math.min(expectedForkCount, totalUserMsgs);
        }

        console.log(`[BranchGraph] Building branch "${branchInfo.branchName}" (${branchSessionId}): forkIndex=${branchInfo.forkIndex}, sharedPrefixCount=${sharedPrefixCount}, parentSession=${branchInfo.parentSessionId}`);

        const branchResult = await this.buildSessionNodes(
          branchSessionId,
          branchInfo.branchName,
          branchInfo.depth,
          nextId,
          nodeIdMap,
          branchInfo.parentSessionId,
          branchInfo.forkIndex,
          sharedPrefixCount
        );

        console.log(`[BranchGraph] Branch "${branchInfo.branchName}": ${branchResult.nodes.length} nodes produced, forkParentNodeId=${branchResult.forkParentNodeId}`);
        if (branchResult.nodes.length > 0) {
          console.log(`[BranchGraph] Branch first node: id=${branchResult.nodes[0].id}, parentIds=[${branchResult.nodes[0].parentIds}]`);
        }

        nodes.push(...branchResult.nodes);
        nextId += branchResult.nodes.length;

        branches.push({
          sessionId: branchSessionId,
          name: branchInfo.branchName,
          status: branchInfo.status,
          depth: branchInfo.depth,
        });

        // Mark actual fork point in parent (not stored forkIndex, which may be wrong for legacy branches)
        const actualForkNodeId = branchResult.forkParentNodeId;
        if (actualForkNodeId !== undefined) {
          const forkNode = nodes.find((n) => n.id === actualForkNodeId);
          if (forkNode) forkNode.isForkPoint = true;
        }

        // Handle merge points — iterate mergeHistory (or legacy fields)
        const mergeRecords: Array<{ toMsgIndex: number; parentMergeIndex: number; label: string }> = [];

        if (branchInfo.mergeHistory && branchInfo.mergeHistory.length > 0) {
          // New-style: multiple merge records
          for (const mr of branchInfo.mergeHistory) {
            mergeRecords.push({
              toMsgIndex: mr.toMsgIndex,
              parentMergeIndex: mr.parentMergeIndex,
              label: `Merge: ${branchInfo.branchName} #${mr.fromMsgIndex + 1}-${mr.toMsgIndex + 1}`,
            });
          }
        } else if (branchInfo.status === "merged" && (branchInfo as any).mergeIndex !== undefined) {
          // Legacy compat: old-style single merge fields
          const legacyMergeIndex = (branchInfo as any).mergeIndex as number;
          const legacyBranchMsgCount = (branchInfo as any).mergeBranchMsgCount as number | undefined;
          mergeRecords.push({
            toMsgIndex: legacyBranchMsgCount !== undefined ? legacyBranchMsgCount - 1 : -1,
            parentMergeIndex: legacyMergeIndex,
            label: `Merge: ${branchInfo.branchName}`,
          });
        }

        for (const mr of mergeRecords) {
          const mergeKey = `${branchInfo.parentSessionId}:${mr.parentMergeIndex}`;
          const mergeNodeId = nodeIdMap.get(mergeKey);
          if (mergeNodeId === undefined) continue;

          const mergeNode = nodes.find((n) => n.id === mergeNodeId);
          if (!mergeNode) continue;

          mergeNode.isMergePoint = true;

          // Find the branch node at the merge turn
          let mergeBranchNode: GraphNode | undefined;
          if (mr.toMsgIndex >= 0) {
            for (let mi = mr.toMsgIndex; mi >= 0; mi--) {
              const key = `${branchSessionId}:${mi}`;
              const nid = nodeIdMap.get(key);
              if (nid !== undefined) {
                mergeBranchNode = nodes.find((n) => n.id === nid);
                if (mergeBranchNode) break;
              }
            }
          }
          if (!mergeBranchNode) {
            mergeBranchNode = [...nodes].reverse().find((n) => n.sessionId === branchSessionId);
          }

          if (!mergeBranchNode) continue;

          // Cycle check
          const visited = new Set<number>();
          const stack = [...mergeBranchNode.parentIds];
          let wouldCycle = false;
          while (stack.length > 0) {
            const nid = stack.pop()!;
            if (nid === mergeNode.id) { wouldCycle = true; break; }
            if (visited.has(nid)) continue;
            visited.add(nid);
            const n = nodes.find((x) => x.id === nid);
            if (n) stack.push(...n.parentIds);
          }

          if (!wouldCycle) {
            mergeNode.parentIds.push(mergeBranchNode.id);
          } else {
            // Create virtual merge node
            const virtualMerge: GraphNode = {
              id: nextId,
              sessionId: task.mainSessionId,
              messageIndex: mergeNode.messageIndex,
              displayMessageIndex: mergeNode.displayMessageIndex,
              messagePreview: `[${mr.label}]`,
              aiReplyPreview: "",
              timestamp: mergeNode.timestamp,
              parentIds: [mergeNode.id, mergeBranchNode.id],
              branchName: mainBranchName,
              isForkPoint: false,
              isMergePoint: true,
              isCurrent: false,
            };
            nodes.push(virtualMerge);
            nextId++;
          }
        }
      }
    }

    // Reorder node ids via DFS through the branch tree.
    // At each fork point in a parent branch, child branch nodes are inserted
    // BEFORE the parent's post-fork continuation. This ensures the layout
    // algorithm (which processes highest-id first) handles parent branch
    // post-fork nodes before child branches, keeping each branch on one track.
    // Invariant preserved: child.id > parent.id for every edge.
    if (hasChildBranches && nodes.length > 1) {
      // Group nodes by sessionId, preserving internal order
      const nodesBySession = new Map<string, GraphNode[]>();
      for (const n of nodes) {
        if (!nodesBySession.has(n.sessionId)) nodesBySession.set(n.sessionId, []);
        nodesBySession.get(n.sessionId)!.push(n);
      }

      // Build map: forkParentNodeId → [child session ids]
      const childBranchesAtFork = new Map<number, string[]>();
      if (meta.branches) {
        for (const [bsid, binfo] of Object.entries(meta.branches)) {
          if (binfo.status === "deleted") continue;
          if (!this.isBranchOfTask(bsid, taskId, meta)) continue;
          const bNodes = nodesBySession.get(bsid);
          if (bNodes && bNodes.length > 0 && bNodes[0].parentIds.length > 0) {
            const forkParentId = bNodes[0].parentIds[0];
            if (!childBranchesAtFork.has(forkParentId))
              childBranchesAtFork.set(forkParentId, []);
            childBranchesAtFork.get(forkParentId)!.push(bsid);
          }
        }
      }

      // DFS: walk a branch's nodes; at each fork point, recurse into children
      const orderedNodes: GraphNode[] = [];
      const visited = new Set<string>();
      const insertBranch = (sessionId: string) => {
        if (visited.has(sessionId)) return;
        visited.add(sessionId);
        const sNodes = nodesBySession.get(sessionId) || [];
        for (const node of sNodes) {
          orderedNodes.push(node);
          const children = childBranchesAtFork.get(node.id);
          if (children) {
            for (const childSid of children) insertBranch(childSid);
          }
        }
      };
      insertBranch(task.mainSessionId);
      // Add any remaining nodes not reached by DFS
      for (const n of nodes) {
        if (!orderedNodes.includes(n)) orderedNodes.push(n);
      }

      // Reassign contiguous ids
      const idRemap = new Map<number, number>();
      for (let i = 0; i < orderedNodes.length; i++) {
        idRemap.set(orderedNodes[i].id, i);
      }
      for (const n of orderedNodes) {
        n.id = idRemap.get(n.id)!;
        n.parentIds = n.parentIds.map((pid) => idRemap.get(pid) ?? pid);
      }

      if (virtualRootId !== null) {
        virtualRootId = idRemap.get(virtualRootId) ?? virtualRootId;
      }
      nodes.length = 0;
      nodes.push(...orderedNodes);
      nextId = orderedNodes.length;
    }

    // Add virtual "main HEAD" node AFTER all branches are built.
    // It must have the highest id so it sorts first (top of graph),
    // creating a visible "main" track that runs the full height.
    // Works for both empty main (links to virtualRoot) and non-empty main
    // (links to the last main node).
    if (hasChildBranches) {
      let mainHeadParentId: number | undefined;
      if (virtualRootId !== null) {
        mainHeadParentId = virtualRootId;
      } else {
        // Main session has nodes — link to the latest main node (highest id)
        const mainNodes = nodes
          .filter((n) => n.sessionId === task.mainSessionId)
          .sort((a, b) => b.id - a.id);
        if (mainNodes.length > 0) {
          mainHeadParentId = mainNodes[0].id;
        }
      }
      if (mainHeadParentId !== undefined) {
        const virtualMainHead: GraphNode = {
          id: nextId,
          sessionId: task.mainSessionId,
          messageIndex: -2,
          displayMessageIndex: -1,
          messagePreview: mainBranchName,
          aiReplyPreview: "",
          timestamp: task.createdAt || new Date().toISOString(),
          parentIds: [mainHeadParentId],
          branchName: mainBranchName,
          isForkPoint: false,
          isMergePoint: false,
          isCurrent: true,
        };
        nodes.push(virtualMainHead);
        nextId++;
      }
    }

    // Mark the latest node on each active branch as isCurrent
    for (const branch of branches) {
      if (branch.status !== "active") continue;
      const branchNodes = nodes
        .filter((n) => n.sessionId === branch.sessionId)
        .sort((a, b) => b.messageIndex - a.messageIndex);
      if (branchNodes.length > 0) {
        branchNodes[0].isCurrent = true;
      }
    }

    // Log final graph summary
    const forkNodes = nodes.filter(n => n.isForkPoint);
    const rootNodes = nodes.filter(n => n.parentIds.length === 0);
    console.log(`[BranchGraph] Final graph: ${nodes.length} nodes, ${branches.length} branches, ${forkNodes.length} forks, ${rootNodes.length} roots`);

    return {
      graph: {
        taskId,
        taskName: task.taskName,
        branches,
        nodes,
      },
    };
  }

  /**
   * Build GraphNode[] from a session JSONL.
   * Only user messages generate nodes; each node gets the
   * following AI reply preview.
   *
   * For branch sessions, messages in the shared prefix (copied from parent)
   * are skipped. sharedPrefixCount = number of user messages to skip.
   * Returns the nodes plus the actual fork parent node ID for accurate
   * fork point marking.
   */
  private async buildSessionNodes(
    sessionId: string,
    branchName: string,
    depth: number,
    startId: number,
    nodeIdMap: Map<string, number>,
    parentSessionId?: string,
    forkIndex?: number,
    sharedPrefixCount?: number
  ): Promise<{ nodes: GraphNode[]; forkParentNodeId?: number }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) return { nodes: [] };

    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());
    const nodes: GraphNode[] = [];

    let msgIndex = 0;
    // displayMsgIndex counts only user messages that handleGetSessionMessages
    // would include (has non-tool_result content). Matches ChatView's userMsgIndexMap.
    let displayMsgIndex = 0;
    let nodeId = startId;
    let lastAiReply = "";
    let lastSkippedParentNodeId: number | undefined;

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === "assistant" && parsed.message?.content) {
          // Extract text for AI reply preview
          const aContent = parsed.message.content;
          if (typeof aContent === "string") {
            lastAiReply = aContent.slice(0, 200);
          } else if (Array.isArray(aContent)) {
            const textParts: string[] = [];
            for (const b of aContent) {
              if (b.type === "text" && b.text) textParts.push(b.text);
            }
            lastAiReply = textParts.join(" ").slice(0, 200);
          }
        }

        if (parsed.type !== "user" || !parsed.message?.content) continue;

        // Check if handleGetSessionMessages would include this user message.
        // It skips tool_result-only messages. String content always passes.
        const isDisplayUser = (typeof parsed.message.content === "string") ||
          (Array.isArray(parsed.message.content) &&
           parsed.message.content.some((b: { type: string }) => b.type !== "tool_result"));

        // Extract user message preview
        let preview = "";
        const userContent = parsed.message.content;
        if (typeof userContent === "string") {
          preview = stripSystemTags(userContent).slice(0, 80);
        } else if (Array.isArray(userContent)) {
          // Try text blocks first
          for (const b of userContent) {
            if (b.type === "text" && b.text) {
              const stripped = stripSystemTags(b.text).slice(0, 80);
              if (stripped) {
                preview = stripped;
                break;
              }
            }
          }
          // If no text found, check for image blocks
          if (!preview && userContent.some((b: { type: string }) => b.type === "image")) {
            preview = "(Image)";
          }
        }

        // Skip user messages with no displayable content
        // (tool_result-only, system-tags-only, or empty messages)
        if (!preview) {
          if (isDisplayUser) displayMsgIndex++;
          msgIndex++;
          continue;
        }

        // For branch sessions, skip shared prefix messages.
        // These are already represented by the parent session's nodes.
        if (sharedPrefixCount !== undefined && msgIndex < sharedPrefixCount) {
          // Track the parent's node at this index for fork point connection
          if (parentSessionId !== undefined) {
            const parentKey = `${parentSessionId}:${msgIndex}`;
            const parentNodeId = nodeIdMap.get(parentKey);
            if (parentNodeId !== undefined) {
              lastSkippedParentNodeId = parentNodeId;
            }
          }
          if (isDisplayUser) displayMsgIndex++;
          msgIndex++;
          lastAiReply = "";
          continue;
        }

        // Determine parent IDs
        const parentIds: number[] = [];
        if (nodes.length > 0) {
          // Linear parent: previous node in this session
          parentIds.push(nodes[nodes.length - 1].id);
        } else if (parentSessionId !== undefined) {
          // First node of a branch — connect to the actual fork point
          // (last skipped parent node, or fall back to forkIndex lookup)
          if (lastSkippedParentNodeId !== undefined) {
            parentIds.push(lastSkippedParentNodeId);
          } else if (forkIndex !== undefined) {
            // Fallback: search backwards from forkIndex for a valid parent node
            for (let i = forkIndex; i >= 0; i--) {
              const key = `${parentSessionId}:${i}`;
              const pid = nodeIdMap.get(key);
              if (pid !== undefined) {
                parentIds.push(pid);
                lastSkippedParentNodeId = pid;
                break;
              }
            }
          }
        }

        const node: GraphNode = {
          id: nodeId,
          sessionId,
          messageIndex: msgIndex,
          displayMessageIndex: displayMsgIndex,
          messagePreview: preview,
          aiReplyPreview: lastAiReply,
          timestamp: parsed.timestamp || new Date().toISOString(),
          parentIds,
          branchName,
          isForkPoint: false,
          isMergePoint: false,
          isCurrent: false,
        };

        nodes.push(node);
        nodeIdMap.set(`${sessionId}:${msgIndex}`, nodeId);
        nodeId++;
        if (isDisplayUser) displayMsgIndex++;
        msgIndex++;
        lastAiReply = "";
      } catch {
        // Skip malformed lines
      }
    }

    return { nodes, forkParentNodeId: lastSkippedParentNodeId };
  }

  /**
   * Get merge preview with range support and merge history info.
   */
  private async handleGetMergePreview(
    branchSessionId: string,
    fromMsgIndex?: number,
    toMsgIndex?: number
  ): Promise<import("../src/types/webview-protocol").MergePreviewResponse> {
    const meta = await this.loadMeta();
    const branch = meta.branches?.[branchSessionId];
    if (!branch) throw new Error(`Branch not found: ${branchSessionId}`);

    const filepath = this.findSessionFile(branchSessionId);
    if (!filepath) throw new Error(`Branch session file not found: ${branchSessionId}`);

    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n").filter((l) => l.trim());

    // Compute available range and total count
    const mergeHistory = branch.mergeHistory || [];
    const lastMerge = mergeHistory.length > 0 ? mergeHistory[mergeHistory.length - 1] : null;
    const availableFromIndex = lastMerge ? lastMerge.toMsgIndex + 1 : 0;

    // Count total user messages and extract content in range
    let userMsgIdx = -1;
    let totalMsgCount = 0;
    let turnCount = 0;
    const rangeTexts: string[] = [];

    // Default range: from availableFromIndex to end
    const effectiveFrom = fromMsgIndex ?? availableFromIndex;
    const effectiveTo = toMsgIndex; // undefined = all remaining

    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type !== "user" && parsed.type !== "assistant") continue;

        if (parsed.type === "user" && parsed.message?.content) {
          userMsgIdx++;
          totalMsgCount = userMsgIdx + 1;
        }

        const inRange = userMsgIdx >= effectiveFrom && (effectiveTo === undefined || userMsgIdx <= effectiveTo);

        if (inRange && parsed.type === "assistant") {
          const blocks = Array.isArray(parsed.message?.content)
            ? parsed.message.content
            : [];
          for (const b of blocks) {
            if (b.type === "text" && b.text) {
              rangeTexts.push(b.text);
            }
          }
          turnCount++;
        }
      } catch { /* skip */ }
    }

    return {
      branchContent: rangeTexts.join("\n\n---\n\n"),
      turnCount,
      availableFromIndex,
      totalMsgCount,
      mergeHistory,
    };
  }

  /**
   * Build the 3-level sidebar tree: Task → Branch → Turn.
   */
  private async handleGetSidebarTree(): Promise<{ tree: SidebarTreeNode[] }> {
    const meta = await this.loadMeta();
    const tree: SidebarTreeNode[] = [];

    // Build task nodes in order
    const taskOrder = meta.taskOrder || Object.keys(meta.tasks || {});
    for (const taskId of taskOrder) {
      const task = meta.tasks?.[taskId];
      if (!task) continue;

      const taskNode: SidebarTreeNode = {
        type: "task",
        id: taskId,
        label: task.taskName,
        children: [],
      };

      // Main branch
      const mainBranchNode = await this.buildBranchTreeNode(
        task.mainSessionId,
        task.mainBranchName || "main",
        "active"
      );
      taskNode.children!.push(mainBranchNode);

      // Child branches
      if (meta.branches) {
        for (const [sessionId, branch] of Object.entries(meta.branches)) {
          if (branch.status === "deleted") continue;
          if (!this.isBranchOfTask(sessionId, taskId, meta)) continue;

          const branchNode = await this.buildBranchTreeNode(
            sessionId,
            branch.branchName,
            branch.status,
            branch.forkIndex
          );
          taskNode.children!.push(branchNode);
        }
      }

      tree.push(taskNode);
    }

    // Gather orphan sessions (not in any task) into "Uncategorized"
    const allTaskSessions = new Set<string>();
    if (meta.tasks) {
      for (const task of Object.values(meta.tasks)) {
        allTaskSessions.add(task.mainSessionId);
      }
    }
    if (meta.branches) {
      for (const sid of Object.keys(meta.branches)) {
        allTaskSessions.add(sid);
      }
    }

    return { tree };
  }

  /**
   * Build a branch-level tree node with turn children.
   * For non-main branches, forkIndex is provided to skip shared prefix messages.
   */
  private async buildBranchTreeNode(
    sessionId: string,
    branchName: string,
    status: "active" | "merged" | "deleted",
    forkIndex?: number
  ): Promise<SidebarTreeNode> {
    const node: SidebarTreeNode = {
      type: "branch",
      id: sessionId,
      label: branchName,
      sessionId,
      branchStatus: status,
      children: [],
    };

    const filepath = this.findSessionFile(sessionId);
    if (!filepath) return node;

    try {
      const content = await fsp.readFile(filepath, "utf-8");
      const lines = content.split("\n").filter((l) => l.trim());
      let msgIndex = 0;
      let displayMsgIndex = 0;

      // For branches, compute shared prefix count to skip inherited messages
      const sharedPrefixCount = forkIndex !== undefined ? forkIndex + 1 : 0;

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type !== "user" || !parsed.message?.content) continue;

          // Check if handleGetSessionMessages would include this
          const isDisplayUser = (typeof parsed.message.content === "string") ||
            (Array.isArray(parsed.message.content) &&
             parsed.message.content.some((b: { type: string }) => b.type !== "tool_result"));

          let preview = "";
          const userContent = parsed.message.content;
          if (typeof userContent === "string") {
            preview = stripSystemTags(userContent).slice(0, 40);
          } else if (Array.isArray(userContent)) {
            // Try text blocks first
            for (const b of userContent) {
              if (b.type === "text" && b.text) {
                const stripped = stripSystemTags(b.text).slice(0, 40);
                if (stripped) {
                  preview = stripped;
                  break;
                }
              }
            }
            // If no text found, check for image blocks
            if (!preview && userContent.some((b: { type: string }) => b.type === "image")) {
              preview = "(Image)";
            }
          }

          // Skip user messages with no displayable content
          if (!preview) {
            if (isDisplayUser) displayMsgIndex++;
            msgIndex++;
            continue;
          }

          // Skip shared prefix messages for branches
          if (msgIndex < sharedPrefixCount) {
            if (isDisplayUser) displayMsgIndex++;
            msgIndex++;
            continue;
          }

          node.children!.push({
            type: "turn",
            id: `${sessionId}:${msgIndex}`,
            label: preview,
            sessionId,
            messageIndex: msgIndex,
            displayMessageIndex: displayMsgIndex,
          });

          if (isDisplayUser) displayMsgIndex++;
          msgIndex++;
        } catch { /* skip */ }
      }
    } catch { /* skip */ }

    return node;
  }

  /**
   * Return all messages for a given session (for the lower panel).
   */
  private async handleGetSessionMessages(
    sessionId: string
  ): Promise<{ messages: CliOutput[] }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) return { messages: [] };

    const MAX_TOOL_RESULT_LEN = 3000;
    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n");
    const messages: CliOutput[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type !== "user" && parsed.type !== "assistant") continue;
        if (!parsed.message?.content) continue;

        // Normalize string content
        if (typeof parsed.message.content === "string") {
          parsed.message.content = [
            { type: "text", text: parsed.message.content },
          ];
        }

        // Filter thinking blocks for assistant messages
        if (parsed.type === "assistant" && Array.isArray(parsed.message.content)) {
          parsed.message.content = parsed.message.content.filter(
            (block: { type: string }) =>
              block.type !== "thinking" && block.type !== "redacted_thinking"
          );
          if (parsed.message.content.length === 0) continue;
        }

        // Skip tool-result-only user messages
        if (parsed.type === "user" && Array.isArray(parsed.message.content)) {
          const hasVisible = parsed.message.content.some(
            (block: { type: string }) => block.type !== "tool_result"
          );
          if (!hasVisible) continue;
        }

        // Truncate large tool results
        if (Array.isArray(parsed.message.content)) {
          for (const block of parsed.message.content) {
            if (block.type === "tool_result" && typeof block.content === "string") {
              if (block.content.length > MAX_TOOL_RESULT_LEN) {
                block.content =
                  block.content.slice(0, MAX_TOOL_RESULT_LEN) +
                  `\n... (truncated, ${block.content.length} chars total)`;
              }
            }
          }
        }

        messages.push(parsed);
      } catch { /* skip */ }
    }

    return { messages };
  }

  /**
   * Move a session from one task to another.
   */
  private async handleMoveSessionToTask(
    sessionId: string,
    targetTaskId: string
  ): Promise<{ success: boolean }> {
    const meta = await this.loadMeta();

    // Find current task owning this session
    const branch = meta.branches?.[sessionId];
    if (!branch) {
      // It's a main session — we'd need to restructure the task
      // For now, only support moving branch sessions
      return { success: false };
    }

    const targetTask = meta.tasks?.[targetTaskId];
    if (!targetTask) return { success: false };

    // Update branch's parent to the target task's main session
    branch.parentSessionId = targetTask.mainSessionId;
    branch.depth = 1; // Reset depth to direct child

    await this.saveMeta(meta);
    console.log(`[Bridge] Moved session ${sessionId} to task ${targetTaskId}`);
    return { success: true };
  }

  /**
   * Create a task from an existing session (import).
   * The session becomes the task's main branch.
   */
  private async handleCreateTaskFromSession(
    sessionId: string,
    taskName: string
  ): Promise<{ taskId: string; mainSessionId: string }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) throw new Error(`Session not found: ${sessionId}`);

    const meta = await this.loadMeta();
    if (!meta.tasks) meta.tasks = {};
    if (!meta.taskOrder) meta.taskOrder = [];

    // Use the existing sessionId as the taskId
    const taskId = sessionId;
    meta.tasks[taskId] = {
      taskId,
      taskName,
      mainSessionId: sessionId,
      createdAt: new Date().toISOString(),
    };
    meta.taskOrder.push(taskId);

    await this.saveMeta(meta);
    console.log(`[Bridge] Created task "${taskName}" from existing session ${sessionId}`);
    return { taskId, mainSessionId: sessionId };
  }

  /**
   * Import an existing session as a branch into an existing task.
   * The session becomes a depth-1 branch under the task's main session.
   */
  private async handleImportSessionToTask(
    sessionId: string,
    targetTaskId: string,
    branchName: string
  ): Promise<{ success: boolean }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) throw new Error(`Session not found: ${sessionId}`);

    const meta = await this.loadMeta();
    const task = meta.tasks?.[targetTaskId];
    if (!task) throw new Error(`Task not found: ${targetTaskId}`);

    if (!meta.branches) meta.branches = {};

    // Count messages in the parent to determine forkIndex (fork at start)
    meta.branches[sessionId] = {
      parentSessionId: task.mainSessionId,
      forkIndex: 0,
      branchName,
      createdAt: new Date().toISOString(),
      status: "active",
      depth: 1,
    };

    await this.saveMeta(meta);
    console.log(`[Bridge] Imported session ${sessionId} as branch "${branchName}" into task ${targetTaskId}`);
    return { success: true };
  }

  /**
   * Get the full user message text for a given turn (session + messageIndex).
   * messageIndex counts ALL user messages in JSONL (same as buildSessionNodes' msgIndex).
   */
  private async handleGetTurnText(
    sessionId: string,
    messageIndex: number
  ): Promise<{ text: string }> {
    const filepath = this.findSessionFile(sessionId);
    if (!filepath) return { text: "" };

    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n");
    let msgIdx = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed.type !== "user" || !parsed.message?.content) continue;

        if (msgIdx === messageIndex) {
          // Extract full text from content blocks
          const uc = parsed.message.content;
          if (typeof uc === "string") return { text: uc };
          if (Array.isArray(uc)) {
            const parts: string[] = [];
            for (const b of uc) {
              if (b.type === "text" && b.text) parts.push(b.text);
            }
            return { text: parts.join("\n") };
          }
          return { text: "" };
        }
        msgIdx++;
      } catch { /* skip */ }
    }

    return { text: "" };
  }

  /**
   * List sessions that are NOT yet part of any task (available for import).
   */
  private async handleListImportableSessions(): Promise<{
    sessions: Array<{ sessionId: string; title: string; messageCount: number }>;
  }> {
    const meta = await this.loadMeta();

    // Collect all session IDs already in tasks
    const usedSessions = new Set<string>();
    if (meta.tasks) {
      for (const task of Object.values(meta.tasks)) {
        usedSessions.add(task.mainSessionId);
      }
    }
    if (meta.branches) {
      for (const sid of Object.keys(meta.branches)) {
        usedSessions.add(sid);
      }
    }

    // List all sessions, filter out the ones already used
    const allSessions = await this.handleListSessions();
    const importable = allSessions.sessions.filter(
      (s) => !usedSessions.has(s.sessionId)
    );

    return {
      sessions: importable.map((s) => ({
        sessionId: s.sessionId,
        title: s.title,
        messageCount: s.messageCount,
      })),
    };
  }

  // ============================================================
  // Branch Graph — JSONL utilities
  // ============================================================

  /**
   * Read a JSONL file and return content up to (and including) the
   * message at the given index. Index counts only user messages
   * (matching buildSessionNodes' msgIndex).
   */
  private async truncateJsonlAtIndex(
    filepath: string,
    targetIndex: number
  ): Promise<string> {
    const content = await fsp.readFile(filepath, "utf-8");
    const lines = content.split("\n");
    const kept: string[] = [];
    let msgIndex = 0;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const parsed = JSON.parse(trimmed);

        // Count only user messages to match buildSessionNodes' msgIndex
        if (parsed.type === "user") {
          if (msgIndex > targetIndex) break;
          msgIndex++;
        }

        kept.push(trimmed);
      } catch {
        // Keep non-JSON lines (shouldn't happen, but safe)
        kept.push(trimmed);
      }
    }

    return kept.join("\n") + "\n";
  }

  // ============================================================
  // Channel lifecycle
  // ============================================================

  private removeChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.abortController.abort();
      if (channel.alive) {
        channel.proc.kill();
        channel.alive = false;
      }
      this.channels.delete(channelId);
    }
  }

  private interruptChannel(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel?.alive) {
      channel.proc.kill("SIGINT");
    }
  }

  dispose(): void {
    for (const [id] of this.channels) {
      this.removeChannel(id);
    }
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("Bridge disposed"));
    }
    this.pendingRequests.clear();
  }
}

// ============================================================
// Strip IDE/system context tags from user message text
// ============================================================

const SYSTEM_TAG_RE =
  /<(ide_selection|ide_opened_file|local-command-caveat|system-reminder|user-prompt-submit-hook|context-window|antml_thinking)>[\s\S]*?<\/\1>/g;

function stripSystemTags(text: string): string {
  return text.replace(SYSTEM_TAG_RE, "").trim();
}

// ============================================================
// Git-bash detection (Windows only)
// ============================================================

function findGitBash(): string | undefined {
  const candidates: string[] = [
    // Standard Git for Windows installs
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    // User-local installs
    path.join(os.homedir(), "AppData", "Local", "Programs", "Git", "bin", "bash.exe"),
    // Scoop
    path.join(os.homedir(), "scoop", "apps", "git", "current", "bin", "bash.exe"),
  ];

  // Derive Git root from PATH entries containing "git"
  const pathEnv = process.env.PATH || process.env.Path || "";
  for (const dir of pathEnv.split(";")) {
    const lower = dir.toLowerCase();
    if (!lower.includes("git")) continue;

    // Try bash.exe directly in this PATH dir
    const direct = path.join(dir, "bash.exe");
    if (fs.existsSync(direct)) {
      candidates.unshift(direct);
    }

    // Derive Git root: walk up to find Git\bin\bash.exe
    // e.g. D:\APP\Git\cmd → D:\APP\Git\bin\bash.exe
    //      D:\APP\Git\usr\bin → D:\APP\Git\bin\bash.exe
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
