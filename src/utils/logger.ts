import * as vscode from "vscode";

let outputChannel: vscode.LogOutputChannel | undefined;

export function createLogger(name: string): vscode.LogOutputChannel {
  if (!outputChannel) {
    outputChannel = vscode.window.createOutputChannel(name, { log: true });
  }
  return outputChannel;
}

export function getLogger(): vscode.LogOutputChannel {
  if (!outputChannel) {
    return createLogger("Claude VSCode");
  }
  return outputChannel;
}

export function log(message: string): void {
  getLogger().info(message);
}

export function logError(message: string, error?: unknown): void {
  const errMsg = error instanceof Error ? error.message : String(error ?? "");
  getLogger().error(`${message}${errMsg ? ": " + errMsg : ""}`);
}

export function logDebug(message: string): void {
  getLogger().debug(message);
}
