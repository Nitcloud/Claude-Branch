/**
 * MessageModel — data model for chat messages and content blocks.
 * Equivalent to AU/LY classes in the original webview/index.js.
 */

import type { ContentBlock, TokenUsage, CompactMetadata } from "../../src/types/cli-protocol";

export type MessageRole = "user" | "assistant" | "system";

export interface MessageModel {
  /** Unique message ID */
  uuid: string;
  /** Message role */
  role: MessageRole;
  /** Content blocks */
  content: ContentBlockModel[];
  /** Token usage */
  usage?: TokenUsage;
  /** Stop reason */
  stopReason?: string;
  /** Model used */
  model?: string;
  /** Parent tool use ID (for sub-agent responses) */
  parentToolUseId?: string;
  /** Whether this is a synthetic message */
  isSynthetic?: boolean;
  /** Whether this message has an error */
  error?: string;

  // ★ Compaction fix fields
  /** Whether this message is from before a context compaction boundary */
  isCompacted?: boolean;
  /** Compact metadata (only on compact_boundary system messages) */
  compactMetadata?: CompactMetadata;
  /** Compact summary text */
  compactSummary?: string;
  /** Whether this is a compact boundary marker */
  isCompactBoundary?: boolean;
}

export interface ContentBlockModel {
  /** Index in the parent message */
  index: number;
  /** The content block data */
  block: ContentBlock;
  /** Whether this block is still streaming */
  isPartial: boolean;
}

let uuidCounter = 0;

export function generateUuid(): string {
  return `msg-${++uuidCounter}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Create a MessageModel from a raw CLI message.
 */
export function createMessageModel(raw: {
  type: string;
  uuid?: string;
  message?: {
    role: string;
    content: ContentBlock[];
    usage?: TokenUsage;
    stop_reason?: string;
    model?: string;
  };
  parent_tool_use_id?: string | null;
  isSynthetic?: boolean;
  error?: string;
  // System message fields
  subtype?: string;
  compact_metadata?: CompactMetadata;
}): MessageModel | null {
  if (raw.type === "system") {
    if (raw.subtype === "compact_boundary") {
      return {
        uuid: raw.uuid || generateUuid(),
        role: "system",
        content: [],
        isCompactBoundary: true,
        compactMetadata: raw.compact_metadata,
      };
    }
    // Other system messages (init, status, etc.) are handled elsewhere
    return null;
  }

  if (!raw.message) return null;

  // Normalize content: CLI sometimes sends a plain string instead of an array
  let rawContent = raw.message.content;
  if (typeof rawContent === "string") {
    rawContent = [{ type: "text", text: rawContent }] as ContentBlock[];
  }
  if (!Array.isArray(rawContent)) return null;

  const content: ContentBlockModel[] = rawContent.map(
    (block, index) => ({
      index,
      block,
      isPartial: false,
    })
  );

  return {
    uuid: raw.uuid || generateUuid(),
    role: raw.message.role as MessageRole,
    content,
    usage: raw.message.usage,
    stopReason: raw.message.stop_reason,
    model: raw.message.model,
    parentToolUseId: raw.parent_tool_use_id ?? undefined,
    isSynthetic: raw.isSynthetic,
    error: raw.error,
  };
}

/**
 * Create a compact boundary marker message.
 */
export function createCompactBoundaryMessage(
  metadata: CompactMetadata
): MessageModel {
  return {
    uuid: generateUuid(),
    role: "system",
    content: [],
    isCompactBoundary: true,
    compactMetadata: metadata,
  };
}
