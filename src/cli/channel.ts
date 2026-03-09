/**
 * Channel — maps a channelId to a CLI process instance.
 * Each webview conversation gets its own channel.
 */

import type { CliProcess } from "./process-manager";
import { logDebug } from "../utils/logger";

export interface Channel {
  channelId: string;
  process: CliProcess;
  sessionId?: string;
  abortController: AbortController;
}

export class ChannelManager {
  private channels = new Map<string, Channel>();

  add(channelId: string, process: CliProcess, sessionId?: string): Channel {
    const channel: Channel = {
      channelId,
      process,
      sessionId,
      abortController: new AbortController(),
    };
    this.channels.set(channelId, channel);
    logDebug(`Channel created: ${channelId}`);
    return channel;
  }

  get(channelId: string): Channel | undefined {
    return this.channels.get(channelId);
  }

  remove(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel) {
      channel.abortController.abort();
      if (channel.process.alive) {
        channel.process.kill();
      }
      this.channels.delete(channelId);
      logDebug(`Channel removed: ${channelId}`);
    }
  }

  interrupt(channelId: string): void {
    const channel = this.channels.get(channelId);
    if (channel?.process.alive) {
      channel.process.interrupt();
      logDebug(`Channel interrupted: ${channelId}`);
    }
  }

  getAll(): Channel[] {
    return Array.from(this.channels.values());
  }

  dispose(): void {
    for (const [id] of this.channels) {
      this.remove(id);
    }
  }
}
