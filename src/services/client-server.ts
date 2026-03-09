/**
 * ClientServer — the core bridge between webview and CLI process.
 * Routes messages bidirectionally.
 * Equivalent to the d$ class in the original extension.js.
 */

import * as vscode from "vscode";
import type {
  WebviewToExtension,
  ExtensionToWebview,
  OutgoingRequest,
} from "../types/webview-protocol";
import type { CliOutput, CliControlRequest } from "../types/cli-protocol";
import { ChannelManager } from "../cli/channel";
import {
  spawnClaude,
  findClaudeBinaryFromInstalledExtension,
} from "../cli/process-manager";
import {
  handleControlRequest,
  type PermissionRequestHandler,
} from "../cli/control-handler";
import { log, logDebug, logError } from "../utils/logger";

export class ClientServer implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private pendingRequests = new Map<
    string,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private sendQueue: Promise<void> = Promise.resolve();

  constructor(
    private webview: vscode.Webview,
    private channelManager: ChannelManager,
    private claudeBinaryPath: string,
    private extensionUri: vscode.Uri
  ) {
    // Listen for messages from the webview
    this.disposables.push(
      webview.onDidReceiveMessage((msg) => this.onWebviewMessage(msg))
    );
  }

  /**
   * Send a message to the webview.
   */
  sendToWebview(message: ExtensionToWebview): void {
    this.sendQueue = this.sendQueue.then(async () => {
      try {
        await this.webview.postMessage({
          type: "from-extension",
          message,
        });
      } catch {
        // Webview might be disposed
      }
    });
  }

  /**
   * Handle a message from the webview.
   */
  private async onWebviewMessage(msg: WebviewToExtension): Promise<void> {
    try {
      switch (msg.type) {
        case "launch_claude":
          await this.handleLaunchClaude(msg);
          break;

        case "close_channel":
          this.channelManager.remove(msg.channelId);
          break;

        case "interrupt_claude":
          this.channelManager.interrupt(msg.channelId);
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
          logDebug(
            `Unhandled webview message type: ${(msg as { type: string }).type}`
          );
      }
    } catch (err) {
      logError("Error handling webview message", err);
    }
  }

  /**
   * Launch a new Claude CLI process for a channel.
   */
  private async handleLaunchClaude(msg: {
    channelId: string;
    resume?: string;
    cwd?: string;
    model?: string;
    permissionMode?: string;
    thinkingLevel?: string;
    sessionId?: string;
    agent?: string;
    initialPrompt?: string;
  }): Promise<void> {
    const cwd =
      msg.cwd ||
      vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ||
      process.cwd();

    // Try to find binary: first our resources, then installed extension
    let binaryPath = this.claudeBinaryPath;
    try {
      // Verify our binary exists
      await vscode.workspace.fs.stat(vscode.Uri.file(binaryPath));
    } catch {
      // Fall back to installed Claude Code extension binary
      const installedPath = findClaudeBinaryFromInstalledExtension();
      if (installedPath) {
        binaryPath = installedPath;
        log(`Using installed Claude Code binary: ${binaryPath}`);
      } else {
        this.sendToWebview({
          type: "close_channel",
          channelId: msg.channelId,
          error:
            "Claude binary not found. Install the official Claude Code extension or place claude.exe in resources/native-binary/",
        });
        return;
      }
    }

    const permissionMode =
      msg.permissionMode ||
      vscode.workspace
        .getConfiguration("claudeCode")
        .get<string>("initialPermissionMode") ||
      "default";

    const cliProcess = spawnClaude(binaryPath, {
      cwd,
      model: msg.model,
      permissionMode,
      thinkingLevel: msg.thinkingLevel,
      resumeSessionId: msg.resume,
      sessionId: msg.sessionId,
      agent: msg.agent,
      onStderr: (data) => {
        logDebug(`[CLI stderr] ${data}`);
      },
      onExit: (code) => {
        this.sendToWebview({
          type: "close_channel",
          channelId: msg.channelId,
          error: code !== 0 ? `CLI exited with code ${code}` : undefined,
        });
        this.channelManager.remove(msg.channelId);
      },
    });

    const channel = this.channelManager.add(
      msg.channelId,
      cliProcess,
      msg.sessionId
    );

    // Start reading messages from CLI
    this.readCliMessages(msg.channelId, channel.abortController.signal);

    // If there's an initial prompt, send it
    if (msg.initialPrompt) {
      cliProcess.write({
        type: "user",
        session_id: msg.sessionId || "",
        message: {
          role: "user",
          content: [{ type: "text", text: msg.initialPrompt }],
        },
        parent_tool_use_id: null,
      });
    }
  }

  /**
   * Read messages from CLI stdout and forward to webview.
   */
  private async readCliMessages(
    channelId: string,
    signal: AbortSignal
  ): Promise<void> {
    const channel = this.channelManager.get(channelId);
    if (!channel) return;

    try {
      for await (const message of channel.process.messages()) {
        if (signal.aborted) break;

        switch (message.type) {
          case "keep_alive":
            // Ignore heartbeats
            break;

          case "control_request":
            await this.handleCliControlRequest(
              channelId,
              message as CliControlRequest
            );
            break;

          case "control_cancel_request":
            // Cancel a pending permission request in the webview
            this.sendToWebview({
              type: "cancel_request",
              targetRequestId: message.request_id,
            });
            break;

          case "result":
            // Forward result to webview
            this.sendToWebview({
              type: "io_message",
              channelId,
              message,
              done: true,
            });
            break;

          default:
            // Forward all other messages to webview
            if (
              message.type !== "streamlined_text" &&
              message.type !== "streamlined_tool_use_summary"
            ) {
              this.sendToWebview({
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
      if (!signal.aborted) {
        logError(`Error reading CLI messages for channel ${channelId}`, err);
      }
    }
  }

  /**
   * Handle a control_request from the CLI (permission, hook, MCP).
   */
  private async handleCliControlRequest(
    channelId: string,
    request: CliControlRequest
  ): Promise<void> {
    const channel = this.channelManager.get(channelId);
    if (!channel) return;

    const permissionHandler: PermissionRequestHandler = async (
      requestId,
      toolName,
      toolInput,
      suggestions,
      description
    ) => {
      // Forward permission request to webview and wait for response
      return new Promise((resolve) => {
        const webviewRequestId = `perm-${requestId}`;

        this.pendingRequests.set(webviewRequestId, {
          resolve: (value) => resolve(value as { accepted: boolean; updatedInput?: Record<string, unknown> }),
          reject: () => resolve({ accepted: false }),
        });

        this.sendToWebview({
          type: "request",
          channelId,
          requestId: webviewRequestId,
          request: {
            type: "tool_permission_request",
            toolName,
            toolInput,
            suggestions,
            description,
            requestId: webviewRequestId,
          },
        });
      });
    };

    await handleControlRequest(channel.process, request, {
      onPermissionRequest: permissionHandler,
    });
  }

  /**
   * Handle an io_message from the webview (user input).
   */
  private handleIoMessage(msg: {
    channelId: string;
    message: unknown;
  }): void {
    const channel = this.channelManager.get(msg.channelId);
    if (channel?.process.alive) {
      const line = JSON.stringify(msg.message) + "\n";
      channel.process.process.stdin?.write(line, "utf-8");
    }
  }

  /**
   * Handle a request from the webview.
   */
  private async handleRequest(msg: {
    channelId?: string;
    requestId: string;
    request: OutgoingRequest;
  }): Promise<void> {
    const { requestId, request } = msg;

    try {
      const result = await this.processRequest(request, msg.channelId);
      this.sendToWebview({
        type: "response" as const,
        requestId,
        response: result,
      } as ExtensionToWebview);
    } catch (err) {
      logError(`Request error (${request.type})`, err);
      this.sendToWebview({
        type: "response" as const,
        requestId,
        response: {
          error: err instanceof Error ? err.message : "Internal error",
        },
      } as ExtensionToWebview);
    }
  }

  /**
   * Process a request from the webview and return the result.
   */
  private async processRequest(
    request: OutgoingRequest,
    channelId?: string
  ): Promise<unknown> {
    switch (request.type) {
      case "init":
        return this.handleInit();

      case "get_claude_state":
        return this.handleGetClaudeState();

      case "get_current_selection":
        return this.handleGetCurrentSelection();

      case "list_files_request":
        return this.handleListFiles(request.pattern);

      case "open_file":
        return this.handleOpenFile(request);

      case "open_content":
        return this.handleOpenContent(request);

      case "open_url":
        return this.handleOpenUrl(request.url);

      case "open_output_panel":
        vscode.commands.executeCommand("claude-vscode.showLogs");
        return {};

      case "show_notification":
        return this.handleShowNotification(request);

      case "rename_tab":
        return this.handleRenameTab(request);

      case "new_conversation_tab":
        return this.handleNewConversationTab(request);

      case "log_event":
        logDebug(`[event] ${request.event}: ${JSON.stringify(request.data)}`);
        return {};

      case "get_asset_uris":
        return this.handleGetAssetUris(request.assets);

      case "set_permission_mode":
      case "set_model":
      case "set_thinking_level":
        // These are forwarded to the CLI via io_message by the webview
        return {};

      case "list_sessions_request":
        return this.handleListSessions();

      case "check_git_status":
        return {};

      // Branch Graph requests — handled by standalone bridge only
      case "create_task":
      case "rename_task":
      case "delete_task":
      case "reorder_tasks":
      case "create_branch":
      case "merge_branch":
      case "delete_branch":
      case "rollback_session":
      case "get_branch_graph":
      case "get_merge_preview":
      case "get_sidebar_tree":
      case "get_session_messages":
      case "move_session_to_task":
      case "create_task_from_session":
      case "import_session_to_task":
      case "list_importable_sessions":
        logDebug(`Branch graph request "${request.type}" — requires standalone bridge`);
        return { error: "Branch graph features require standalone mode" };

      default:
        logDebug(`Unhandled request type: ${request.type}`);
        return {};
    }
  }

  private handleInit(): unknown {
    const workspaceFolders = vscode.workspace.workspaceFolders?.map((f) => ({
      name: f.name,
      path: f.uri.fsPath,
    })) ?? [];

    return {
      workspaceFolders,
      platform: process.platform,
      version: "0.1.0",
    };
  }

  private handleGetClaudeState(): unknown {
    return {
      isAuthenticated: true, // TODO: actual auth check
      model: vscode.workspace.getConfiguration("claudeCode").get("selectedModel") || "default",
    };
  }

  private handleGetCurrentSelection(): unknown {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return null;
    }

    const selection = editor.selection;
    const selectedText = editor.document.getText(selection);
    const relativePath = vscode.workspace.asRelativePath(
      editor.document.uri,
      false
    );

    return {
      fileName: editor.document.fileName,
      relativePath,
      languageId: editor.document.languageId,
      selectedText,
      startLine: selection.start.line + 1,
      endLine: selection.end.line + 1,
    };
  }

  private async handleListFiles(
    pattern: string
  ): Promise<{ files: string[] }> {
    const files: string[] = [];
    const glob = pattern || "**/*";

    try {
      const uris = await vscode.workspace.findFiles(glob, undefined, 100);
      for (const uri of uris) {
        files.push(vscode.workspace.asRelativePath(uri, false));
      }
    } catch {
      // Ignore search errors
    }

    return { files };
  }

  private async handleOpenFile(request: {
    filePath: string;
    location?: { line?: number; column?: number };
  }): Promise<unknown> {
    try {
      const uri = vscode.Uri.file(request.filePath);
      const doc = await vscode.workspace.openTextDocument(uri);
      const options: vscode.TextDocumentShowOptions = {
        preserveFocus: true,
      };
      if (request.location?.line) {
        const line = Math.max(0, request.location.line - 1);
        const col = Math.max(0, (request.location.column ?? 1) - 1);
        options.selection = new vscode.Range(line, col, line, col);
      }
      await vscode.window.showTextDocument(doc, options);
      return { success: true };
    } catch (err) {
      return {
        error: err instanceof Error ? err.message : "Failed to open file",
      };
    }
  }

  private async handleOpenContent(request: {
    content: string;
    fileName: string;
    editable: boolean;
  }): Promise<unknown> {
    const doc = await vscode.workspace.openTextDocument({
      content: request.content,
      language: this.getLanguageId(request.fileName),
    });
    await vscode.window.showTextDocument(doc, { preserveFocus: true });
    return { success: true };
  }

  private async handleOpenUrl(url: string): Promise<unknown> {
    await vscode.env.openExternal(vscode.Uri.parse(url));
    return { success: true };
  }

  private async handleShowNotification(request: {
    level: "info" | "warning" | "error";
    message: string;
    buttons?: string[];
  }): Promise<unknown> {
    const buttons = request.buttons ?? [];
    let result: string | undefined;

    switch (request.level) {
      case "error":
        result = await vscode.window.showErrorMessage(
          request.message,
          ...buttons
        );
        break;
      case "warning":
        result = await vscode.window.showWarningMessage(
          request.message,
          ...buttons
        );
        break;
      default:
        result = await vscode.window.showInformationMessage(
          request.message,
          ...buttons
        );
    }

    return { clicked: result };
  }

  private handleRenameTab(request: {
    channelId: string;
    title: string;
    iconState?: string;
  }): unknown {
    // Panel title updates would go here
    logDebug(
      `Rename tab: ${request.channelId} -> ${request.title} (${request.iconState})`
    );
    return {};
  }

  private handleNewConversationTab(request: {
    sessionId?: string;
    initialPrompt?: string;
  }): unknown {
    // This would trigger creating a new panel
    logDebug(
      `New conversation tab: sessionId=${request.sessionId}, prompt=${request.initialPrompt?.slice(0, 50)}`
    );
    return {};
  }

  private handleGetAssetUris(assets: string[]): unknown {
    const uris: Record<string, string> = {};
    for (const asset of assets) {
      const uri = vscode.Uri.joinPath(this.extensionUri, "resources", asset);
      uris[asset] = this.webview
        .asWebviewUri(uri)
        .toString();
    }
    return { uris };
  }

  private async handleListSessions(): Promise<unknown> {
    // TODO: implement session listing from ~/.claude/projects/
    return { sessions: [] };
  }

  private getLanguageId(fileName: string): string {
    const ext = fileName.split(".").pop()?.toLowerCase();
    const map: Record<string, string> = {
      ts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      jsx: "javascriptreact",
      py: "python",
      rs: "rust",
      go: "go",
      java: "java",
      c: "c",
      cpp: "cpp",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      rb: "ruby",
      php: "php",
      swift: "swift",
      kt: "kotlin",
      md: "markdown",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      toml: "toml",
      xml: "xml",
      html: "html",
      css: "css",
      scss: "scss",
      sql: "sql",
      sh: "shellscript",
      bash: "shellscript",
    };
    return map[ext ?? ""] || "plaintext";
  }

  /**
   * Handle a response from the webview (to a pending request).
   */
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

  dispose(): void {
    for (const [, pending] of this.pendingRequests) {
      pending.reject(new Error("ClientServer disposed"));
    }
    this.pendingRequests.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}
