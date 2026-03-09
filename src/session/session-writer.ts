/**
 * Session Writer — fork, rename, and delete sessions.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { logDebug, logError } from "../utils/logger";

/**
 * Delete a session file.
 */
export async function deleteSession(
  sessionDir: string,
  sessionId: string
): Promise<boolean> {
  const filepath = path.join(sessionDir, `${sessionId}.jsonl`);
  try {
    await fs.unlink(filepath);
    logDebug(`Deleted session: ${sessionId}`);
    return true;
  } catch (err) {
    logError(`Failed to delete session: ${sessionId}`, err);
    return false;
  }
}

/**
 * Rename a session (stored as metadata in the JSONL file).
 */
export async function renameSession(
  sessionDir: string,
  sessionId: string,
  newName: string
): Promise<boolean> {
  const filepath = path.join(sessionDir, `${sessionId}.jsonl`);
  try {
    // Append a rename metadata line
    const metadata = JSON.stringify({
      type: "metadata",
      subtype: "rename",
      name: newName,
      timestamp: Date.now(),
    });
    await fs.appendFile(filepath, "\n" + metadata + "\n");
    logDebug(`Renamed session ${sessionId} to "${newName}"`);
    return true;
  } catch (err) {
    logError(`Failed to rename session: ${sessionId}`, err);
    return false;
  }
}

/**
 * Fork a session by copying its JSONL file to a new session ID.
 */
export async function forkSession(
  sessionDir: string,
  sourceSessionId: string,
  targetSessionId: string
): Promise<boolean> {
  const sourcePath = path.join(sessionDir, `${sourceSessionId}.jsonl`);
  const targetPath = path.join(sessionDir, `${targetSessionId}.jsonl`);
  try {
    await fs.copyFile(sourcePath, targetPath);
    logDebug(`Forked session ${sourceSessionId} -> ${targetSessionId}`);
    return true;
  } catch (err) {
    logError(`Failed to fork session: ${sourceSessionId}`, err);
    return false;
  }
}
