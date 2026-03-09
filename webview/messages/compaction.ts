/**
 * ★ Compaction fix — preserves ALL messages across compaction boundaries.
 *
 * Original bug: session-reader truncated JSONL files at the last compact_boundary,
 * discarding all pre-compaction messages. This module ensures all messages are
 * retained and marked appropriately for display.
 */

import type { MessageModel } from "./MessageModel";
import { createCompactBoundaryMessage, generateUuid } from "./MessageModel";
import type { CompactMetadata } from "../../src/types/cli-protocol";

/**
 * Process a raw list of messages and mark pre-compaction messages.
 * Instead of hiding them, we keep them all and annotate them.
 *
 * @returns messages - All messages with isCompacted flags set
 * @returns compactionIndices - Indices of compact boundary markers
 */
export function processMessagesWithCompaction(
  messages: MessageModel[]
): {
  messages: MessageModel[];
  compactionIndices: number[];
} {
  const compactionIndices: number[] = [];

  // Find all compact boundary markers
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].isCompactBoundary) {
      compactionIndices.push(i);
    }
  }

  // If there are compaction boundaries, mark all messages before the LAST boundary
  if (compactionIndices.length > 0) {
    const lastBoundaryIndex = compactionIndices[compactionIndices.length - 1];
    for (let i = 0; i < lastBoundaryIndex; i++) {
      if (!messages[i].isCompactBoundary) {
        messages[i].isCompacted = true;
      }
    }
  }

  return { messages, compactionIndices };
}

/**
 * Handle an incoming compact_boundary system event during a live session.
 * Marks all existing messages as compacted and inserts a boundary marker.
 */
export function applyLiveCompaction(
  currentMessages: MessageModel[],
  metadata: CompactMetadata
): MessageModel[] {
  // Mark all existing messages as compacted
  const updated: MessageModel[] = currentMessages.map((msg) => ({
    ...msg,
    isCompacted: true as boolean | undefined,
  }));

  // Add the compact boundary marker
  updated.push(createCompactBoundaryMessage(metadata));

  return updated;
}

/**
 * Format token count for display.
 */
export function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1)}M`;
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}K`;
  }
  return String(tokens);
}
