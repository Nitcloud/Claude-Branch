/**
 * StreamAssembler — reassembles Anthropic SSE stream events into messages.
 * Equivalent to the Gn/vB0 classes in the original webview/index.js.
 */

import type {
  AnthropicSSEvent,
  ContentBlock,
  ContentDelta,
  TokenUsage,
} from "../../src/types/cli-protocol";

export interface StreamMessage {
  id: string;
  role: string;
  model: string;
  content: StreamContentBlock[];
  usage: TokenUsage;
  stopReason?: string;
  parentToolUseId?: string;
  isComplete: boolean;
}

export interface StreamContentBlock {
  index: number;
  block: ContentBlock;
  isPartial: boolean;
  /** Accumulated partial JSON for tool_use input */
  _partialJson?: string;
}

export type StreamCallback = (
  event: "message_start" | "content_update" | "message_complete",
  message: StreamMessage,
  blockIndex?: number
) => void;

/**
 * Per-message assembler. Handles the stream events for a single message.
 */
class MessageAssembler {
  message: StreamMessage | null = null;

  processEvent(event: AnthropicSSEvent): {
    type: "message_start" | "content_update" | "message_complete" | "ignore";
    message: StreamMessage | null;
    blockIndex?: number;
  } {
    switch (event.type) {
      case "message_start":
        return this.handleMessageStart(event);
      case "content_block_start":
        return this.handleContentBlockStart(event);
      case "content_block_delta":
        return this.handleContentBlockDelta(event);
      case "content_block_stop":
        return this.handleContentBlockStop(event);
      case "message_delta":
        return this.handleMessageDelta(event);
      case "message_stop":
        return this.handleMessageStop();
      default:
        return { type: "ignore", message: this.message };
    }
  }

  private handleMessageStart(event: AnthropicSSEvent) {
    const msg = event.message!;
    this.message = {
      id: msg.id,
      role: msg.role,
      model: msg.model,
      content: [],
      usage: msg.usage || {},
      stopReason: msg.stop_reason,
      isComplete: false,
    };
    return { type: "message_start" as const, message: this.message };
  }

  private handleContentBlockStart(event: AnthropicSSEvent) {
    if (!this.message) return { type: "ignore" as const, message: null };

    const block: StreamContentBlock = {
      index: event.index!,
      block: event.content_block!,
      isPartial: true,
    };

    // Initialize partial JSON accumulator for tool_use
    if (
      block.block.type === "tool_use" ||
      block.block.type === "server_tool_use"
    ) {
      block._partialJson = "";
    }

    this.message.content.push(block);
    return {
      type: "content_update" as const,
      message: this.message,
      blockIndex: event.index,
    };
  }

  private handleContentBlockDelta(event: AnthropicSSEvent) {
    if (!this.message) return { type: "ignore" as const, message: null };

    const idx = event.index!;
    const block = this.message.content.find((b) => b.index === idx);
    if (!block) return { type: "ignore" as const, message: this.message };

    const delta = event.delta!;
    this.applyDelta(block, delta);

    return {
      type: "content_update" as const,
      message: this.message,
      blockIndex: idx,
    };
  }

  private applyDelta(block: StreamContentBlock, delta: ContentDelta): void {
    switch (delta.type) {
      case "text_delta":
        if (block.block.type === "text" && delta.text) {
          (block.block as { text: string }).text += delta.text;
        }
        break;

      case "input_json_delta":
        if (delta.partial_json) {
          block._partialJson = (block._partialJson ?? "") + delta.partial_json;
        }
        break;

      case "thinking_delta":
        if (block.block.type === "thinking" && delta.thinking) {
          (block.block as { thinking: string }).thinking += delta.thinking;
        }
        break;

      case "signature_delta":
        if (block.block.type === "thinking" && delta.signature) {
          (block.block as { signature?: string }).signature = delta.signature;
        }
        break;

      case "citations_delta":
        if (block.block.type === "text" && delta.citations) {
          const textBlock = block.block as {
            citations?: unknown[];
          };
          textBlock.citations = [
            ...(textBlock.citations ?? []),
            ...delta.citations,
          ];
        }
        break;
    }
  }

  private handleContentBlockStop(event: AnthropicSSEvent) {
    if (!this.message) return { type: "ignore" as const, message: null };

    const idx = event.index!;
    const block = this.message.content.find((b) => b.index === idx);
    if (block) {
      block.isPartial = false;

      // Parse accumulated partial JSON for tool_use
      if (
        block._partialJson &&
        (block.block.type === "tool_use" ||
          block.block.type === "server_tool_use")
      ) {
        try {
          (block.block as { input: unknown }).input = JSON.parse(
            block._partialJson
          );
        } catch {
          // Keep empty input if parse fails
        }
        block._partialJson = undefined;
      }
    }

    return {
      type: "content_update" as const,
      message: this.message,
      blockIndex: idx,
    };
  }

  private handleMessageDelta(event: AnthropicSSEvent) {
    if (!this.message) return { type: "ignore" as const, message: null };

    if (event.delta) {
      const delta = event.delta as unknown as Record<string, unknown>;
      if (delta.stop_reason) {
        this.message.stopReason = delta.stop_reason as string;
      }
    }

    if (event.usage) {
      this.message.usage = {
        ...this.message.usage,
        ...event.usage,
      };
    }

    return { type: "content_update" as const, message: this.message };
  }

  private handleMessageStop() {
    if (!this.message) return { type: "ignore" as const, message: null };
    this.message.isComplete = true;
    const msg = this.message;
    this.message = null;
    return { type: "message_complete" as const, message: msg };
  }
}

/**
 * Top-level stream assembler. Routes events by parentToolUseId.
 */
export class StreamAssembler {
  private assemblers = new Map<string, MessageAssembler>();
  private callback: StreamCallback;

  constructor(callback: StreamCallback) {
    this.callback = callback;
  }

  processStreamEvent(
    event: AnthropicSSEvent,
    parentToolUseId?: string
  ): void {
    const key = parentToolUseId ?? "__root__";

    if (!this.assemblers.has(key)) {
      this.assemblers.set(key, new MessageAssembler());
    }

    const assembler = this.assemblers.get(key)!;
    const result = assembler.processEvent(event);

    if (result.type !== "ignore" && result.message) {
      result.message.parentToolUseId = parentToolUseId;
      this.callback(result.type, result.message, result.blockIndex);
    }

    if (result.type === "message_complete") {
      this.assemblers.delete(key);
    }
  }

  reset(): void {
    this.assemblers.clear();
  }
}
