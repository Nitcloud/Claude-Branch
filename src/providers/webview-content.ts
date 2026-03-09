/**
 * HTML template generator for webview panels.
 * Creates the HTML shell with CSP, nonce, and script/CSS URIs.
 */

import * as vscode from "vscode";
import * as crypto from "crypto";

export function getWebviewHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  options: {
    isSidebar?: boolean;
    isFullEditor?: boolean;
    initialPrompt?: string;
    initialSessionId?: string;
  } = {}
): string {
  const nonce = crypto.randomBytes(16).toString("hex");

  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "index.js")
  );
  const styleUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview", "index.css")
  );

  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} https: data:`,
    `script-src 'nonce-${nonce}'`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `connect-src https: wss:`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <link rel="stylesheet" href="${styleUri}">
  <title>Claude Code</title>
</head>
<body>
  <div id="root"></div>
  <script nonce="${nonce}">
    window.vscodeApi = acquireVsCodeApi();
    window.__CODEPILOT_CONFIG__ = {
      IS_SIDEBAR: ${options.isSidebar ?? false},
      IS_FULL_EDITOR: ${options.isFullEditor ?? true},
      INITIAL_PROMPT: ${JSON.stringify(options.initialPrompt ?? "")},
      INITIAL_SESSION: ${JSON.stringify(options.initialSessionId ?? "")},
    };
  </script>
  <script nonce="${nonce}" type="module" src="${scriptUri}"></script>
</body>
</html>`;
}
