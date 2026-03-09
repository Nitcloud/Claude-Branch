/**
 * WebviewPanel provider — manages editor tab webview panels.
 * Equivalent to the QA class in the original extension.js.
 */

import * as vscode from "vscode";
import { getWebviewHtml } from "./webview-content";
import { ClientServer } from "../services/client-server";
import { ChannelManager } from "../cli/channel";
import { logDebug, log } from "../utils/logger";

export class WebviewPanelManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>();
  private clientServers = new Map<string, ClientServer>();
  private disposables: vscode.Disposable[] = [];

  constructor(
    private extensionUri: vscode.Uri,
    private channelManager: ChannelManager,
    private claudeBinaryPath: string
  ) {}

  /**
   * Create or reveal a webview panel in the editor.
   */
  createPanel(options: {
    viewColumn?: vscode.ViewColumn;
    sessionId?: string;
    initialPrompt?: string;
  } = {}): vscode.WebviewPanel {
    const panelId = `panel-${Date.now()}`;
    const column = options.viewColumn ?? vscode.ViewColumn.Active;

    const panel = vscode.window.createWebviewPanel(
      "claudeVSCodePanel",
      "Claude Code",
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        enableFindWidget: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.extensionUri, "dist"),
          vscode.Uri.joinPath(this.extensionUri, "resources"),
        ],
      }
    );

    panel.iconPath = vscode.Uri.joinPath(
      this.extensionUri,
      "resources",
      "claude-logo.svg"
    );

    panel.webview.html = getWebviewHtml(panel.webview, this.extensionUri, {
      isFullEditor: true,
      initialPrompt: options.initialPrompt,
      initialSessionId: options.sessionId,
    });

    // Create client-server bridge for this panel
    const clientServer = new ClientServer(
      panel.webview,
      this.channelManager,
      this.claudeBinaryPath,
      this.extensionUri
    );

    this.panels.set(panelId, panel);
    this.clientServers.set(panelId, clientServer);

    panel.onDidDispose(() => {
      logDebug(`Panel disposed: ${panelId}`);
      clientServer.dispose();
      this.panels.delete(panelId);
      this.clientServers.delete(panelId);
    });

    log(`Panel created: ${panelId}`);
    return panel;
  }

  /**
   * Get a webview for the sidebar view.
   */
  resolveWebviewView(
    webviewView: vscode.WebviewView
  ): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "resources"),
      ],
    };

    webviewView.webview.html = getWebviewHtml(
      webviewView.webview,
      this.extensionUri,
      { isSidebar: true }
    );

    const sidebarId = "sidebar";
    const clientServer = new ClientServer(
      webviewView.webview,
      this.channelManager,
      this.claudeBinaryPath,
      this.extensionUri
    );

    this.clientServers.set(sidebarId, clientServer);

    webviewView.onDidDispose(() => {
      clientServer.dispose();
      this.clientServers.delete(sidebarId);
    });
  }

  /**
   * Notify all webviews to create a new conversation.
   */
  notifyNewConversation(): void {
    for (const [, cs] of this.clientServers) {
      cs.sendToWebview({
        type: "request",
        channelId: "",
        requestId: `new-conv-${Date.now()}`,
        request: { type: "create_new_conversation" },
      });
    }
  }

  hasPanels(): boolean {
    return this.panels.size > 0 || this.clientServers.has("sidebar");
  }

  dispose(): void {
    for (const [, panel] of this.panels) {
      panel.dispose();
    }
    for (const [, cs] of this.clientServers) {
      cs.dispose();
    }
    this.panels.clear();
    this.clientServers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
  }
}

/**
 * Sidebar WebviewView provider.
 */
export class SidebarProvider implements vscode.WebviewViewProvider {
  constructor(
    private panelManager: WebviewPanelManager
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ): void {
    this.panelManager.resolveWebviewView(webviewView);
  }
}
