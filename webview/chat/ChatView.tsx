/**
 * ChatView — main chat container component.
 * Matches original Claude Code extension layout:
 * - Messages area with padding 20px 20px 40px
 * - Input absolutely positioned at bottom
 * - Spinner row for streaming indicator
 * - Gradient fade at bottom
 *
 * For large replayed sessions, only the most recent MESSAGES_PER_PAGE
 * messages are rendered initially. A "Show earlier" button at the top
 * loads more on demand to keep the browser responsive.
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { MessageModel } from "../messages/MessageModel";
import { MessageBubble } from "./MessageBubble";
import { EmptyState } from "./EmptyState";
import { InputBox } from "../input/InputBox";
import { Session, type SessionState } from "../session/Session";
import { getConnection } from "../connection/Connection";
import type { ExtensionToWebview, IoMessage } from "../../src/types/webview-protocol";
import type { CliOutput } from "../../src/types/cli-protocol";

/** How many messages to render per page. */
const MESSAGES_PER_PAGE = 100;

interface ChatViewProps {
  resumeSessionId?: string;
  /**
   * When true, don't spawn claude.exe on mount. Instead load history
   * via get_session_messages and only launch claude.exe when the user
   * sends the first message. This prevents expensive process spawns
   * from blocking the UI.
   */
  lazyLaunch?: boolean;
  /**
   * When set, scroll to the user message at this index (0-based, counting
   * only user messages). Used by BranchGraphView when clicking a turn/node.
   * Use { index, seq } to allow re-triggering for the same index.
   */
  scrollToMessage?: { index: number; seq: number };
  /** Called when a streaming turn completes (status goes idle after streaming). */
  onTurnComplete?: () => void;
}

export function ChatView({ resumeSessionId, lazyLaunch, scrollToMessage, onTurnComplete }: ChatViewProps): React.ReactElement {
  const [sessionState, setSessionState] = useState<SessionState | null>(null);
  const [channelId] = useState(() => `ch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  /** Number of messages to display (grows as user clicks "show more"). */
  const [displayCount, setDisplayCount] = useState(MESSAGES_PER_PAGE);
  const [thinkingEnabled, setThinkingEnabled] = useState(true);
  const [effortLevel, setEffortLevel] = useState("high");
  /** Whether claude.exe has been launched for this ChatView instance. */
  const launchedRef = useRef(false);
  const sessionRef = useRef<Session | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const connection = getConnection();

  // Initialize session
  useEffect(() => {
    const session = new Session(channelId, (state) => {
      setSessionState({ ...state });
    });
    sessionRef.current = session;

    // Listen for messages from extension
    const unsubscribe = connection.onMessageReceived((message: ExtensionToWebview) => {
      if (message.type === "io_message" && message.channelId === channelId) {
        session.processIncomingMessage(message.message as CliOutput);
      } else if (message.type === "replay_batch" && message.channelId === channelId) {
        // Chunked replay: accumulate silently, render on last chunk
        session.processReplayBatch(message.messages as CliOutput[], message.isLast);
      } else if (message.type === "close_channel" && message.channelId === channelId) {
        if (message.error) {
          setSessionState((prev) =>
            prev ? { ...prev, status: "error", error: message.error } : null
          );
        }
      }
    });

    if (lazyLaunch && resumeSessionId) {
      // Lazy mode: load history without spawning claude.exe
      connection
        .sendRequest<{ messages: CliOutput[] }>({
          type: "get_session_messages",
          sessionId: resumeSessionId,
        })
        .then((result) => {
          if (result.messages.length > 0) {
            session.processReplayBatch(result.messages, true);
          } else {
            session.processReplayBatch([], true);
          }
        })
        .catch((err) => {
          console.error("[ChatView] Failed to load session history:", err);
          session.processReplayBatch([], true);
        });
    } else {
      // Eager mode: init + launch claude.exe immediately
      const doInit = () => {
        connection
          .sendRequest({ type: "init" })
          .then(() => {
            launchedRef.current = true;
            connection.launchClaude({
              channelId,
              ...(resumeSessionId ? { resume: resumeSessionId } : {}),
            });
          })
          .catch((err) => {
            console.error("[ChatView] Init failed:", err);
            setSessionState((prev) =>
              prev ? { ...prev, status: "error", error: String(err) } : null
            );
          });
      };

      if (connection.ready) {
        doInit();
      } else {
        connection.onReady(doInit);
      }
    }

    return () => {
      unsubscribe();
      if (launchedRef.current) {
        connection.closeChannel(channelId);
      }
    };
  }, [channelId]);

  // ── Derived data (must be before useEffects that reference them) ──

  const allMessages = sessionState?.messages ?? [];
  const totalCount = allMessages.length;
  const status = sessionState?.status ?? "connecting";
  const isStreaming = status === "streaming" || status === "tool_use";

  // Notify parent when a streaming turn completes (streaming/tool_use → idle)
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && status === "idle") {
      onTurnComplete?.();
    }
    prevStreamingRef.current = isStreaming;
  }, [isStreaming, status, onTurnComplete]);

  // Build a map: array index → user message index (0-based, user msgs only)
  const userMsgIndexMap = useMemo(() => {
    const map = new Map<number, number>();
    let userIdx = 0;
    for (let i = 0; i < allMessages.length; i++) {
      if (allMessages[i].role === "user") {
        map.set(i, userIdx);
        userIdx++;
      }
    }
    return map;
  }, [allMessages]);

  // Windowed display: only render the last `displayCount` messages
  const startIndex = Math.max(0, totalCount - displayCount);
  const displayedMessages = allMessages.slice(startIndex);
  const hiddenCount = startIndex;

  // Track whether a scroll-to-message request is pending — suppresses auto-scroll
  const pendingScrollRef = useRef(false);
  const lastScrollSeqRef = useRef(-1);
  /** Tracks whether the initial batch of messages has been scrolled into view. */
  const didInitialScrollRef = useRef(false);

  // Mark pending when we receive a new scroll request
  useEffect(() => {
    if (scrollToMessage && scrollToMessage.seq !== lastScrollSeqRef.current) {
      pendingScrollRef.current = true;
    }
  }, [scrollToMessage]);

  // Scroll to bottom after initial message load (replay batch), unless a
  // scroll-to-message is pending. Also auto-scroll during live streaming.
  useEffect(() => {
    if (pendingScrollRef.current) return;
    if (totalCount === 0) return;

    // Initial load: scroll to bottom once
    if (!didInitialScrollRef.current) {
      didInitialScrollRef.current = true;
      requestAnimationFrame(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "auto" });
      });
      return;
    }

    // During streaming: auto-scroll to bottom
    if (isStreaming && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [totalCount, isStreaming]);

  // Scroll to a specific user message by index when requested.
  // Watches both the scroll request AND totalCount so it retries
  // after async message loading completes.
  useEffect(() => {
    if (!scrollToMessage || scrollToMessage.index < 0) return;
    if (!messagesContainerRef.current) return;
    if (totalCount === 0) return;

    // Find the array index of the target user message
    let targetArrayIdx = -1;
    for (const [arrIdx, userIdx] of userMsgIndexMap) {
      if (userIdx === scrollToMessage.index) {
        targetArrayIdx = arrIdx;
        break;
      }
    }
    if (targetArrayIdx < 0) return;

    // Deduplicate: don't re-scroll if we already handled this exact request
    if (lastScrollSeqRef.current === scrollToMessage.seq) return;
    lastScrollSeqRef.current = scrollToMessage.seq;

    // If the target is hidden (before startIndex), expand to include it
    if (targetArrayIdx < startIndex) {
      const needed = totalCount - targetArrayIdx;
      setDisplayCount(Math.max(needed, displayCount));
    }

    // Scroll after render — use double rAF to ensure DOM has updated after displayCount change
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const el = messagesContainerRef.current?.querySelector(
          `[data-msg-index="${scrollToMessage.index}"]`
        );
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "center" });
          el.classList.add("message-highlight");
          setTimeout(() => el.classList.remove("message-highlight"), 1500);
        }
        pendingScrollRef.current = false;
      });
    });
  }, [scrollToMessage, userMsgIndexMap, totalCount, startIndex, displayCount]);

  // Handle sending a message
  const handleSend = useCallback(
    (text: string) => {
      if (!text.trim()) return;

      // Lazy launch: spawn claude.exe on first message if not yet launched
      if (!launchedRef.current) {
        launchedRef.current = true;
        const doLaunch = () => {
          connection
            .sendRequest({ type: "init" })
            .then(() => {
              connection.launchClaude({
                channelId,
                ...(resumeSessionId ? { resume: resumeSessionId } : {}),
                initialPrompt: text,
                // Skip bridge-side replay — we already loaded history via get_session_messages
                skipReplay: true,
              });
            })
            .catch((err) => {
              console.error("[ChatView] Lazy launch failed:", err);
              launchedRef.current = false;
            });
        };
        if (connection.ready) {
          doLaunch();
        } else {
          connection.onReady(doLaunch);
        }
        return;
      }

      connection.sendUserMessage(channelId, [{ type: "text", text }]);
    },
    [channelId, connection, resumeSessionId]
  );

  // Handle interrupt
  const handleInterrupt = useCallback(() => {
    connection.interrupt(channelId);
  }, [channelId, connection]);

  // Handle permission mode change — optimistic update + send to bridge
  const handlePermissionModeChange = useCallback(
    (mode: string) => {
      // Optimistic: update UI immediately
      setSessionState((prev) =>
        prev ? { ...prev, permissionMode: mode } : null
      );
      connection.sendRequest({ type: "set_permission_mode", mode }, channelId);
    },
    [channelId, connection]
  );

  // Handle model change — optimistic update + send to bridge
  const handleModelChange = useCallback(
    (model: string) => {
      // Optimistic: update UI immediately
      setSessionState((prev) =>
        prev ? { ...prev, model } : null
      );
      connection.sendRequest({ type: "set_model", model }, channelId);
    },
    [channelId, connection]
  );

  // Handle thinking toggle
  const handleToggleThinking = useCallback(
    (enabled: boolean) => {
      setThinkingEnabled(enabled);
    },
    []
  );

  // Handle effort level change
  const handleEffortChange = useCallback(
    (level: string) => {
      setEffortLevel(level);
    },
    []
  );

  // Load more messages
  const handleLoadMore = useCallback(() => {
    // Remember scroll height before adding messages so we can restore position
    const container = messagesContainerRef.current;
    const prevScrollHeight = container?.scrollHeight ?? 0;

    setDisplayCount((prev) => prev + MESSAGES_PER_PAGE);

    // After React renders the new messages, restore scroll position
    // so the user stays at the same place (not jumped to top).
    requestAnimationFrame(() => {
      if (container) {
        const newScrollHeight = container.scrollHeight;
        container.scrollTop += newScrollHeight - prevScrollHeight;
      }
    });
  }, []);

  return (
    <div className="chat-view">
      {/* Messages area */}
      <div className="messages-container" ref={messagesContainerRef}>
        {totalCount === 0 && status !== "streaming" ? (
          <EmptyState />
        ) : (
          <>
            {/* "Show earlier messages" button */}
            {hiddenCount > 0 && (
              <button
                className="load-more-button"
                onClick={handleLoadMore}
              >
                Show {Math.min(MESSAGES_PER_PAGE, hiddenCount)} earlier messages
                ({hiddenCount} hidden)
              </button>
            )}

            {displayedMessages.map((msg, i) => {
              const globalIdx = startIndex + i;
              const userIdx = userMsgIndexMap.get(globalIdx);
              return (
                <div
                  key={msg.uuid}
                  {...(userIdx !== undefined ? { "data-msg-index": userIdx } : {})}
                >
                  <MessageBubble
                    message={msg}
                    isLast={globalIdx === totalCount - 1}
                  />
                </div>
              );
            })}

            {/* Spinner row when streaming */}
            {isStreaming && totalCount > 0 && (
              <div className="spinner-row">
                <div className="spinner" />
              </div>
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Gradient fade at bottom */}
      <div className="message-gradient" />

      {/* Input — absolutely positioned at bottom */}
      <div className="input-outer">
        <InputBox
          onSend={handleSend}
          onInterrupt={handleInterrupt}
          isStreaming={isStreaming}
          disabled={status === "connecting"}
          permissionMode={sessionState?.permissionMode ?? "default"}
          model={sessionState?.model}
          totalInputTokens={sessionState?.totalInputTokens ?? 0}
          totalOutputTokens={sessionState?.totalOutputTokens ?? 0}
          thinkingEnabled={thinkingEnabled}
          effortLevel={effortLevel}
          onPermissionModeChange={handlePermissionModeChange}
          onModelChange={handleModelChange}
          onToggleThinking={handleToggleThinking}
          onEffortChange={handleEffortChange}
        />
      </div>
    </div>
  );
}
