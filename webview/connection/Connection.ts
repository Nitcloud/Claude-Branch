/**
 * Connection — bidirectional message bridge.
 *
 * Supports two transport modes:
 * 1. VSCode postMessage (when running as extension webview)
 * 2. WebSocket (when running as standalone browser app)
 *
 * Auto-detected: if window.vscodeApi exists → postMessage;
 * otherwise → WebSocket via __CODEPILOT_CONFIG__.WS_URL.
 */

import type {
  ExtensionToWebview,
  IoMessage,
  IncomingRequestMessage,
} from "../../src/types/webview-protocol";

type MessageHandler = (message: ExtensionToWebview) => void;

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare global {
  interface Window {
    vscodeApi?: VsCodeApi;
    __CODEPILOT_CONFIG__: {
      IS_SIDEBAR: boolean;
      IS_FULL_EDITOR: boolean;
      INITIAL_PROMPT: string;
      INITIAL_SESSION: string;
      WS_URL?: string;
    };
  }
}

let requestIdCounter = 0;

// ============================================================
// Transport interface
// ============================================================

interface Transport {
  send(message: unknown): void;
  onMessage(callback: (data: unknown) => void): void;
  readonly ready: boolean;
  onReady(callback: () => void): void;
}

/**
 * VSCode postMessage transport.
 */
class PostMessageTransport implements Transport {
  private api: VsCodeApi;
  ready = true;

  constructor() {
    this.api = window.vscodeApi!;
  }

  send(message: unknown): void {
    this.api.postMessage(message);
  }

  onMessage(callback: (data: unknown) => void): void {
    window.addEventListener("message", (event) => {
      callback(event.data);
    });
  }

  onReady(callback: () => void): void {
    callback(); // Already ready
  }
}

/**
 * WebSocket transport for standalone browser mode.
 */
class WebSocketTransport implements Transport {
  private ws!: WebSocket;
  private messageQueue: unknown[] = [];
  private readyCallbacks: Array<() => void> = [];
  private messageCallbacks: Array<(data: unknown) => void> = [];
  ready = false;

  constructor(private url: string) {
    this.connect();
  }

  private connect(): void {
    this.ws = new WebSocket(this.url);

    this.ws.addEventListener("open", () => {
      console.log("[Connection] WebSocket connected");
      this.ready = true;
      // Flush queued messages
      for (const msg of this.messageQueue) {
        this.ws.send(JSON.stringify(msg));
      }
      this.messageQueue = [];
      // Notify ready listeners
      for (const cb of this.readyCallbacks) cb();
      this.readyCallbacks = [];
    });

    this.ws.addEventListener("message", (event) => {
      try {
        const data = JSON.parse(event.data);
        for (const cb of this.messageCallbacks) {
          cb(data);
        }
      } catch {
        // Ignore non-JSON messages
      }
    });

    this.ws.addEventListener("close", () => {
      console.log("[Connection] WebSocket disconnected");
      this.ready = false;
      setTimeout(() => this.connect(), 2000);
    });

    this.ws.addEventListener("error", (err) => {
      console.error("[Connection] WebSocket error:", err);
    });
  }

  send(message: unknown): void {
    if (this.ready && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    } else {
      this.messageQueue.push(message);
    }
  }

  onMessage(callback: (data: unknown) => void): void {
    this.messageCallbacks.push(callback);
  }

  onReady(callback: () => void): void {
    if (this.ready) {
      callback();
    } else {
      this.readyCallbacks.push(callback);
    }
  }
}

// ============================================================
// Connection
// ============================================================

export class Connection {
  private handlers: MessageHandler[] = [];
  private pendingRequests = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (err: Error) => void;
    }
  >();
  private transport: Transport;

  constructor() {
    // Auto-detect transport mode
    if (window.vscodeApi) {
      this.transport = new PostMessageTransport();
    } else {
      const wsUrl =
        window.__CODEPILOT_CONFIG__?.WS_URL ||
        `ws://${location.host}/ws`;
      this.transport = new WebSocketTransport(wsUrl);
    }

    this.transport.onMessage((data: unknown) => {
      const msg = data as { type?: string; message?: ExtensionToWebview };
      if (msg?.type === "from-extension" && msg.message) {
        this.onMessage(msg.message);
      }
    });
  }

  private onMessage(message: ExtensionToWebview): void {
    // Handle response to pending request
    if (message.type === "response") {
      const pending = this.pendingRequests.get(message.requestId);
      if (pending) {
        this.pendingRequests.delete(message.requestId);
        pending.resolve(message.response);
        return;
      }
    }

    // Dispatch to handlers
    for (const handler of this.handlers) {
      handler(message);
    }
  }

  /**
   * Whether the connection is ready to send messages.
   */
  get ready(): boolean {
    return this.transport.ready;
  }

  /**
   * Register a callback for when the connection becomes ready.
   */
  onReady(callback: () => void): void {
    this.transport.onReady(callback);
  }

  /**
   * Register a message handler.
   */
  onMessageReceived(handler: MessageHandler): () => void {
    this.handlers.push(handler);
    return () => {
      const idx = this.handlers.indexOf(handler);
      if (idx >= 0) this.handlers.splice(idx, 1);
    };
  }

  /**
   * Send a message to the server (fire-and-forget).
   */
  postMessage(message: unknown): void {
    this.transport.send(message);
  }

  /**
   * Send a request and wait for a response.
   */
  sendRequest<T = unknown>(
    request: { type: string; [key: string]: unknown },
    channelId?: string
  ): Promise<T> {
    const requestId = `req-${++requestIdCounter}-${Date.now()}`;

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(requestId, {
        resolve: resolve as (v: unknown) => void,
        reject,
      });

      this.postMessage({
        type: "request",
        channelId,
        requestId,
        request,
      });

      // Timeout after 10s
      setTimeout(() => {
        if (this.pendingRequests.has(requestId)) {
          this.pendingRequests.delete(requestId);
          console.error(`[Connection] Request timeout: ${request.type} (${requestId})`);
          reject(new Error(`Request timeout: ${request.type}`));
        }
      }, 10000);
    });
  }

  /**
   * Send a response to an incoming request from the server.
   */
  sendResponse(requestId: string, response: unknown): void {
    this.postMessage({
      type: "response",
      requestId,
      response,
    });
  }

  /**
   * Launch a Claude session.
   */
  launchClaude(options: {
    channelId: string;
    resume?: string;
    cwd?: string;
    model?: string;
    permissionMode?: string;
    thinkingLevel?: string;
    initialPrompt?: string;
    sessionId?: string;
    skipReplay?: boolean;
  }): void {
    this.postMessage({
      type: "launch_claude",
      ...options,
    });
  }

  /**
   * Send user input to the CLI.
   */
  sendUserMessage(
    channelId: string,
    content: Array<{ type: string; [key: string]: unknown }>
  ): void {
    this.postMessage({
      type: "io_message",
      channelId,
      message: {
        type: "user",
        session_id: "",
        message: {
          role: "user",
          content,
        },
        parent_tool_use_id: null,
      },
      done: false,
    });
  }

  /**
   * Interrupt the current Claude operation.
   */
  interrupt(channelId: string): void {
    this.postMessage({
      type: "interrupt_claude",
      channelId,
    });
  }

  /**
   * Close a channel.
   */
  closeChannel(channelId: string): void {
    this.postMessage({
      type: "close_channel",
      channelId,
    });
  }
}

// Singleton
let connectionInstance: Connection | null = null;

export function getConnection(): Connection {
  if (!connectionInstance) {
    connectionInstance = new Connection();
  }
  return connectionInstance;
}
