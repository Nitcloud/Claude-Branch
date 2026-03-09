/**
 * Session Store — lists and queries sessions from the filesystem.
 */

import * as path from "path";
import {
  getProjectsDir,
  listSessions,
  readSessionFile,
  parseSessionMessages,
  type ParsedSessionMessage,
} from "./session-reader";
import { logDebug, logError } from "../utils/logger";

export interface SessionSummary {
  sessionId: string;
  title?: string;
  lastModified: Date;
  messageCount: number;
  hasCompaction: boolean;
}

export interface FullSession {
  sessionId: string;
  messages: ParsedSessionMessage[];
  hasCompaction: boolean;
  compactionCount: number;
}

/**
 * Get the session directory for a given workspace path.
 */
export function getSessionDir(workspacePath: string): string {
  // Claude stores sessions in ~/.claude/projects/<hash>/sessions/
  // The hash is derived from the workspace path
  const sanitized = workspacePath
    .replace(/[^a-zA-Z0-9]/g, "-")
    .replace(/-+/g, "-")
    .toLowerCase();

  return path.join(getProjectsDir(), sanitized, "sessions");
}

/**
 * ★ Load a full session with ALL messages (including pre-compaction).
 */
export async function loadFullSession(
  sessionDir: string,
  sessionId: string
): Promise<FullSession | null> {
  const filename = `${sessionId}.jsonl`;
  const buf = await readSessionFile(sessionDir, filename);
  if (!buf) return null;

  const messages = parseSessionMessages(buf);
  const compactionCount = messages.filter(
    (m) => m.type === "system" && m.subtype === "compact_boundary"
  ).length;

  logDebug(
    `Loaded session ${sessionId}: ${messages.length} messages, ${compactionCount} compactions`
  );

  return {
    sessionId,
    messages,
    hasCompaction: compactionCount > 0,
    compactionCount,
  };
}
