/**
 * Session — per-conversation state model.
 * Equivalent to the cX class in the original webview/index.js.
 */

import type { MessageModel } from "../messages/MessageModel";
import { createMessageModel, generateUuid } from "../messages/MessageModel";
import { StreamAssembler, type StreamMessage } from "../messages/StreamAssembler";
import { applyLiveCompaction } from "../messages/compaction";
import type { CliOutput, CliSystemMessage, CompactMetadata } from "../../src/types/cli-protocol";

export type SessionStatus =
  | "idle"
  | "connecting"
  | "streaming"
  | "waiting_input"
  | "tool_use"
  | "error";

export interface SessionState {
  sessionId: string;
  channelId: string;
  status: SessionStatus;
  messages: MessageModel[];
  model?: string;
  title?: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCost: number;
  permissionMode: string;
  error?: string;
}

export class Session {
  state: SessionState;
  private streamAssembler: StreamAssembler;
  private onStateChange: (state: SessionState) => void;
  /** Current streaming message being assembled */
  private currentStreamMessage: MessageModel | null = null;

  constructor(
    channelId: string,
    onStateChange: (state: SessionState) => void,
    sessionId?: string
  ) {
    this.onStateChange = onStateChange;
    this.state = {
      sessionId: sessionId || generateUuid(),
      channelId,
      status: "connecting",
      messages: [],
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCost: 0,
      permissionMode: "default",
    };

    this.streamAssembler = new StreamAssembler((eventType, message, blockIndex) => {
      this.handleStreamEvent(eventType, message, blockIndex);
    });
  }

  /**
   * Process a chunk of replayed historical messages.
   * Accumulates silently — only triggers a React re-render when isLast=true.
   */
  processReplayBatch(messages: CliOutput[], isLast: boolean): void {
    for (const msg of messages) {
      this.processIncomingMessageSilent(msg);
    }
    if (isLast) {
      this.state.status = "idle";
      this.notify();
    }
  }

  /**
   * Process a single message without triggering a state notification.
   * Used by processReplayBatch for performance.
   */
  private processIncomingMessageSilent(cliMessage: CliOutput): void {
    switch (cliMessage.type) {
      case "user": {
        const model = createMessageModel(cliMessage as Parameters<typeof createMessageModel>[0]);
        if (model) {
          this.state.messages.push(model);
        }
        break;
      }
      case "assistant": {
        const model = createMessageModel(cliMessage as Parameters<typeof createMessageModel>[0]);
        if (model) {
          this.state.messages.push(model);
        }
        break;
      }
      case "system":
        this.handleSystemMessage(cliMessage as CliSystemMessage);
        break;
      default:
        break;
    }
  }

  /**
   * Process an incoming message from the CLI (via the extension host).
   */
  processIncomingMessage(cliMessage: CliOutput): void {
    switch (cliMessage.type) {
      case "system":
        this.handleSystemMessage(cliMessage as CliSystemMessage);
        break;

      case "stream_event":
        this.streamAssembler.processStreamEvent(
          cliMessage.event,
          cliMessage.parent_tool_use_id
        );
        break;

      case "assistant":
        this.handleCompleteAssistantMessage(cliMessage);
        break;

      case "user":
        this.handleUserMessage(cliMessage);
        break;

      case "result":
        this.handleResult(cliMessage);
        break;

      case "tool_permission_request":
        this.updateStatus("waiting_input");
        break;

      default:
        break;
    }
  }

  private handleSystemMessage(msg: CliSystemMessage): void {
    switch (msg.subtype) {
      case "init":
        this.state.sessionId = msg.session_id || this.state.sessionId;
        this.state.model = msg.model;
        this.updateStatus("idle");
        break;

      case "status":
        if (msg.permissionMode) {
          this.state.permissionMode = msg.permissionMode;
        }
        if ((msg as Record<string, unknown>).model) {
          this.state.model = (msg as Record<string, unknown>).model as string;
        }
        this.notify();
        break;

      case "compact_boundary":
        // ★ COMPACTION FIX: Mark existing messages as compacted, don't delete
        if (msg.compact_metadata) {
          this.state.messages = applyLiveCompaction(
            this.state.messages,
            msg.compact_metadata
          );
          this.notify();
        }
        break;

      case "task_started":
      case "task_progress":
      case "task_notification":
        // Sub-agent events — forward to UI
        break;
    }
  }

  private handleStreamEvent(
    eventType: "message_start" | "content_update" | "message_complete",
    streamMsg: StreamMessage,
    blockIndex?: number
  ): void {
    switch (eventType) {
      case "message_start": {
        // Create a new message model for the streaming message
        this.currentStreamMessage = {
          uuid: streamMsg.id || generateUuid(),
          role: streamMsg.role as "assistant",
          content: streamMsg.content.map((sc) => ({
            index: sc.index,
            block: sc.block,
            isPartial: sc.isPartial,
          })),
          usage: streamMsg.usage,
          model: streamMsg.model,
          parentToolUseId: streamMsg.parentToolUseId,
        };
        this.state.messages.push(this.currentStreamMessage);
        this.updateStatus("streaming");
        break;
      }

      case "content_update": {
        // Update the current streaming message in place
        if (this.currentStreamMessage) {
          this.currentStreamMessage.content = streamMsg.content.map((sc) => ({
            index: sc.index,
            block: sc.block,
            isPartial: sc.isPartial,
          }));
          this.currentStreamMessage.usage = streamMsg.usage;
          this.currentStreamMessage.stopReason = streamMsg.stopReason;
          this.notify();
        }
        break;
      }

      case "message_complete": {
        // Finalize the streaming message
        if (this.currentStreamMessage) {
          this.currentStreamMessage.content = streamMsg.content.map((sc) => ({
            index: sc.index,
            block: sc.block,
            isPartial: false,
          }));
          this.currentStreamMessage.usage = streamMsg.usage;
          this.currentStreamMessage.stopReason = streamMsg.stopReason;
          this.currentStreamMessage = null;

          // Update token counts
          if (streamMsg.usage) {
            this.state.totalInputTokens +=
              streamMsg.usage.input_tokens ?? 0;
            this.state.totalOutputTokens +=
              streamMsg.usage.output_tokens ?? 0;
          }

          // Check if we need tool input or are done
          const lastContent = streamMsg.content[streamMsg.content.length - 1];
          if (
            lastContent?.block.type === "tool_use" ||
            lastContent?.block.type === "server_tool_use"
          ) {
            this.updateStatus("tool_use");
          } else {
            this.updateStatus("idle");
          }
        }
        break;
      }
    }
  }

  private handleCompleteAssistantMessage(raw: unknown): void {
    const model = createMessageModel(raw as Parameters<typeof createMessageModel>[0]);
    if (model) {
      // Replace streaming message if it matches, or add new
      const existingIdx = this.state.messages.findIndex(
        (m) => m.uuid === model.uuid
      );
      if (existingIdx >= 0) {
        this.state.messages[existingIdx] = model;
      } else {
        this.state.messages.push(model);
      }
      this.notify();
    }
  }

  private handleUserMessage(raw: unknown): void {
    const model = createMessageModel(raw as Parameters<typeof createMessageModel>[0]);
    if (model) {
      this.state.messages.push(model);
      this.notify();
    }
  }

  private handleResult(result: { total_cost_usd?: number; is_error?: boolean }): void {
    if (result.total_cost_usd) {
      this.state.totalCost = result.total_cost_usd;
    }
    if (result.is_error) {
      this.updateStatus("error");
    } else {
      this.updateStatus("idle");
    }
  }

  private updateStatus(status: SessionStatus): void {
    this.state.status = status;
    this.notify();
  }

  private notify(): void {
    this.onStateChange({ ...this.state });
  }

  reset(): void {
    this.state.messages = [];
    this.streamAssembler.reset();
    this.currentStreamMessage = null;
    this.updateStatus("idle");
  }
}
