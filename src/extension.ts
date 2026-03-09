/**
 * Extension entry point — activate/deactivate.
 * Registers commands, webview providers, and services.
 */

import * as vscode from "vscode";
import { createLogger, log, logError } from "./utils/logger";
import { ChannelManager } from "./cli/channel";
import {
  findClaudeBinary,
  findClaudeBinaryFromInstalledExtension,
} from "./cli/process-manager";
import {
  WebviewPanelManager,
  SidebarProvider,
} from "./providers/webview-panel";

let isActive = false;

export function activate(context: vscode.ExtensionContext): void {
  isActive = true;
  const logger = createLogger("Claude VSCode");
  log("CodePilot Claude extension activating...");

  // Find claude binary
  let claudeBinaryPath: string;
  try {
    claudeBinaryPath = findClaudeBinary(context.extensionPath);
    log(`Found claude binary: ${claudeBinaryPath}`);
  } catch {
    // Try installed extension
    const installed = findClaudeBinaryFromInstalledExtension();
    if (installed) {
      claudeBinaryPath = installed;
      log(`Using installed Claude Code binary: ${claudeBinaryPath}`);
    } else {
      claudeBinaryPath = ""; // Will fail gracefully when trying to launch
      log("Claude binary not found - will search on launch");
    }
  }

  // Create managers
  const channelManager = new ChannelManager();
  const panelManager = new WebviewPanelManager(
    context.extensionUri,
    channelManager,
    claudeBinaryPath
  );

  // Register sidebar provider
  const sidebarProvider = new SidebarProvider(panelManager);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      "claudeVSCodeSidebar",
      sidebarProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // Register commands
  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.editor.open", (args?: {
      sessionId?: string;
      initialPrompt?: string;
      viewColumn?: vscode.ViewColumn;
    }) => {
      panelManager.createPanel({
        viewColumn: args?.viewColumn ?? vscode.ViewColumn.Active,
        sessionId: args?.sessionId,
        initialPrompt: args?.initialPrompt,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.editor.openLast", () => {
      const preferred = vscode.workspace
        .getConfiguration("claudeCode")
        .get<string>("preferredLocation");

      if (preferred === "sidebar") {
        vscode.commands.executeCommand("claude-vscode.sidebar.open");
      } else {
        vscode.commands.executeCommand("claude-vscode.editor.open");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.sidebar.open", () => {
      vscode.commands.executeCommand("claudeVSCodeSidebar.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.newConversation", () => {
      panelManager.notifyNewConversation();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.focus", () => {
      if (!panelManager.hasPanels()) {
        vscode.commands.executeCommand("claude-vscode.editor.openLast");
      }
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.blur", () => {
      vscode.commands.executeCommand(
        "workbench.action.focusFirstEditorGroup"
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.terminal.open", () => {
      const terminal = vscode.window.createTerminal({
        name: process.env.CLAUDE_CODE_TERMINAL_TITLE || "Claude Code",
        shellPath: claudeBinaryPath || undefined,
      });
      terminal.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.showLogs", () => {
      logger.show();
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.logout", async () => {
      vscode.window.showInformationMessage(
        "Logout: not yet implemented in CodePilot Claude."
      );
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("claude-vscode.insertAtMention", () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      const selection = editor.selection;
      const fileName = vscode.workspace.asRelativePath(
        editor.document.uri,
        false
      );

      let mention = `@${fileName}`;
      if (!selection.isEmpty) {
        mention += `#L${selection.start.line + 1}`;
        if (selection.start.line !== selection.end.line) {
          mention += `-L${selection.end.line + 1}`;
        }
      }

      // Send to focused webview
      panelManager.notifyNewConversation(); // TODO: send mention to webview input
    })
  );

  // Accept/reject diff commands (placeholders)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      "claude-vscode.acceptProposedDiff",
      () => {
        log("Accept proposed diff");
      }
    ),
    vscode.commands.registerCommand(
      "claude-vscode.rejectProposedDiff",
      () => {
        log("Reject proposed diff");
      }
    )
  );

  // Status bar item
  const statusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.text = "$(comment-discussion) Claude";
  statusBar.command = "claude-vscode.editor.openLast";
  statusBar.tooltip = "Open Claude Code";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Cleanup on dispose
  context.subscriptions.push({
    dispose() {
      channelManager.dispose();
      panelManager.dispose();
    },
  });

  log("CodePilot Claude extension activated.");
}

export function deactivate(): void {
  log("CodePilot Claude extension deactivated.");
  isActive = false;
}
