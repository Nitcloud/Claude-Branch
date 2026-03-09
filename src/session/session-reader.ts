/**
 * ★ Session Reader — reads and parses session JSONL files.
 *
 * COMPACTION FIX: Unlike the original which truncates at compact_boundary
 * markers (discarding pre-compaction messages), this implementation reads
 * the ENTIRE file and marks pre-compaction messages with _isPreCompaction=true.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { logDebug, logError } from "../utils/logger";

export interface ParsedSessionMessage {
  type: string;
  subtype?: string;
  uuid?: string;
  session_id?: string;
  message?: {
    role: string;
    content: unknown[];
    usage?: unknown;
    stop_reason?: string;
    model?: string;
  };
  parent_tool_use_id?: string | null;
  isSynthetic?: boolean;
  error?: string;
  compact_metadata?: {
    trigger: string;
    pre_tokens: number;
    uuid: string;
    compactSummary?: string;
  };
  /** ★ FIX: Marks messages that precede a compact_boundary */
  _isPreCompaction: boolean;
  /** Raw line offset in the file (for debugging) */
  _offset: number;
}

/**
 * ★ FIX: Read a session file in its ENTIRETY.
 *
 * The original implementation (function `i2` in extension.js) would:
 * 1. Check if file > 5MB
 * 2. If so, scan backwards for `compact_boundary`
 * 3. Return ONLY the bytes after that boundary
 *
 * This discarded all pre-compaction messages permanently.
 * We fix this by ALWAYS reading the full file.
 */
export async function readSessionFile(
  dir: string,
  filename: string
): Promise<Buffer | null> {
  const filepath = path.join(dir, filename);

  try {
    const stat = await fs.stat(filepath);
    if (stat.size === 0) return null;

    // ★ FIX: Always read the complete file, never truncate at compact_boundary
    // The original had: if (stat.size > 5_000_000) { ... truncate ... }
    // We removed that check entirely.
    return await fs.readFile(filepath);
  } catch (err) {
    logError(`Failed to read session file: ${filepath}`, err);
    return null;
  }
}

/**
 * Parse ALL messages from a session JSONL buffer.
 * Marks messages before the last compact_boundary as pre-compaction.
 */
export function parseSessionMessages(buf: Buffer): ParsedSessionMessage[] {
  const messages: ParsedSessionMessage[] = [];
  let offset = 0;
  let lastCompactBoundaryIndex = -1;

  // Split by newlines and parse each line
  const text = buf.toString("utf-8");
  const lines = text.split("\n");

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      offset += line.length + 1;
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const type = parsed.type;

      // Only keep conversation-relevant message types
      if (
        type === "user" ||
        type === "assistant" ||
        type === "system" ||
        type === "progress" ||
        type === "attachment"
      ) {
        const msg: ParsedSessionMessage = {
          ...parsed,
          _isPreCompaction: false,
          _offset: offset,
        };

        messages.push(msg);

        // Track compact boundary positions
        if (type === "system" && parsed.subtype === "compact_boundary") {
          lastCompactBoundaryIndex = messages.length - 1;
        }
      }
    } catch {
      // Skip malformed JSON lines (common in JSONL files)
      logDebug(`Skipping malformed JSONL line at offset ${offset}`);
    }

    offset += line.length + 1;
  }

  // ★ FIX: Mark all messages before the last compact boundary
  if (lastCompactBoundaryIndex >= 0) {
    for (let i = 0; i < lastCompactBoundaryIndex; i++) {
      messages[i]._isPreCompaction = true;
    }
    logDebug(
      `Session has ${lastCompactBoundaryIndex} pre-compaction messages out of ${messages.length} total`
    );
  }

  return messages;
}

/**
 * Get the path to the Claude config directory.
 */
export function getClaudeConfigDir(): string {
  return (
    process.env.CLAUDE_CONFIG_DIR ||
    path.join(
      process.env.HOME || process.env.USERPROFILE || "",
      ".claude"
    )
  );
}

/**
 * Get the projects directory for session storage.
 */
export function getProjectsDir(): string {
  return path.join(getClaudeConfigDir(), "projects");
}

/**
 * List available sessions for a project directory.
 */
export async function listSessions(
  projectDir: string
): Promise<
  Array<{
    sessionId: string;
    filename: string;
    lastModified: Date;
    sizeBytes: number;
  }>
> {
  const sessionsDir = path.join(projectDir, "sessions");

  try {
    const entries = await fs.readdir(sessionsDir, { withFileTypes: true });
    const sessions: Array<{
      sessionId: string;
      filename: string;
      lastModified: Date;
      sizeBytes: number;
    }> = [];

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        const stat = await fs.stat(path.join(sessionsDir, entry.name));
        sessions.push({
          sessionId: entry.name.replace(".jsonl", ""),
          filename: entry.name,
          lastModified: stat.mtime,
          sizeBytes: stat.size,
        });
      }
    }

    // Sort by most recent first
    sessions.sort(
      (a, b) => b.lastModified.getTime() - a.lastModified.getTime()
    );

    return sessions;
  } catch {
    return [];
  }
}
