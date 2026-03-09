/**
 * MessageBubble — renders a single chat message.
 * Matches original Claude Code extension layout exactly:
 * - User messages: inline-block pill with border/bg
 * - Assistant text: plain markdown content
 * - Tool calls: timeline items with colored dots, vertical connector lines,
 *   collapsible headers (tool name bold + secondary monospace), IN/OUT grid
 * - Thinking: <details> italic summary with chevron
 */

import React, { useState } from "react";
import type { MessageModel, ContentBlockModel } from "../messages/MessageModel";
import { CompactBoundary } from "./CompactBoundary";
import { renderMarkdown } from "../markdown/renderMarkdown";

interface Props {
  message: MessageModel;
  isLast?: boolean;
}

export function MessageBubble({ message, isLast }: Props): React.ReactElement | null {
  if (message.isCompactBoundary) {
    return <CompactBoundary message={message} />;
  }

  if (message.role === "system") {
    return null;
  }

  const isUser = message.role === "user";

  // Skip user messages that only contain tool_result blocks
  if (isUser) {
    const hasVisibleContent = message.content.some(
      (b) => b.block.type !== "tool_result"
    );
    if (!hasVisibleContent) return null;
  }

  const wrapperClass = [
    "message",
    message.isCompacted ? "dimmed" : "",
  ].filter(Boolean).join(" ");

  if (isUser) {
    const visibleBlocks = message.content.filter(
      (b) => b.block.type !== "tool_result"
    );
    return (
      <div className={wrapperClass} data-uuid={message.uuid}>
        <div className="user-message-container">
          <div className="user-message">
            {visibleBlocks.map((block) => (
              <UserContentBlock key={block.index} block={block} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // ── Assistant message ──
  // Separate content into: text/thinking (top-level) and tool calls (timeline)
  const topBlocks: ContentBlockModel[] = [];
  const timelineBlocks: ContentBlockModel[] = [];

  for (const block of message.content) {
    const t = block.block.type;
    if (t === "tool_use" || t === "server_tool_use" || t === "tool_result") {
      timelineBlocks.push(block);
    } else {
      topBlocks.push(block);
    }
  }

  return (
    <div className={wrapperClass} data-uuid={message.uuid}>
      {/* Text + thinking blocks */}
      <div className="assistant-content">
        {topBlocks.map((block) => (
          <TopLevelBlock
            key={block.index}
            block={block}
            isStreaming={block.isPartial}
          />
        ))}
      </div>

      {/* Timeline tool calls */}
      {timelineBlocks.length > 0 && (
        <div className="timeline">
          {timelineBlocks.map((block, i) => (
            <TimelineItem
              key={block.index}
              block={block}
              isStreaming={block.isPartial}
              isFirst={i === 0}
              isLast={i === timelineBlocks.length - 1}
            />
          ))}
        </div>
      )}

      {message.error && (
        <div className="error-banner">
          <div className="error-message">{message.error}</div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// System tag stripping
// ============================================================

function stripSystemTags(text: string): string {
  return text
    .replace(
      /<(ide_selection|ide_opened_file|local-command-caveat|system-reminder|user-prompt-submit-hook|context-window|antml_thinking)>[\s\S]*?<\/\1>/g,
      ""
    )
    .trim();
}

// ============================================================
// User content block
// ============================================================

function UserContentBlock({ block }: { block: ContentBlockModel }): React.ReactElement | null {
  const { block: content } = block;
  switch (content.type) {
    case "text": {
      const cleaned = stripSystemTags(content.text);
      if (!cleaned) return null;
      return <span>{cleaned}</span>;
    }
    case "image":
      return (
        <div className="content-image">
          <img
            src={`data:${content.source.media_type};base64,${content.source.data}`}
            alt="Attached image"
            style={{ maxWidth: "100%", maxHeight: "200px", borderRadius: "4px" }}
          />
        </div>
      );
    default:
      return <span>{JSON.stringify(content)}</span>;
  }
}

// ============================================================
// Top-level assistant blocks (text, thinking)
// ============================================================

function TopLevelBlock({
  block,
  isStreaming,
}: {
  block: ContentBlockModel;
  isStreaming: boolean;
}): React.ReactElement | null {
  const { block: content } = block;

  switch (content.type) {
    case "text":
      return (
        <div className="content-text">
          <MarkdownContent text={content.text} />
          {isStreaming && <span className="streaming-cursor">|</span>}
        </div>
      );

    case "thinking":
      return <ThinkingBlock thinking={content.thinking} isStreaming={isStreaming} />;

    case "redacted_thinking":
      return (
        <details className="thinking-block redacted">
          <summary className="thinking-summary">
            <span className="thinking-label">Redacted thinking</span>
            <ChevronIcon className="thinking-toggle" />
          </summary>
          <div className="thinking-content">
            <p>This thinking content has been redacted for safety.</p>
          </div>
        </details>
      );

    case "web_search_tool_result":
      return (
        <div className="content-web-search">
          <div className="web-search-header">Web Search Results</div>
          {content.search_results.map((result: { url: string; title: string; snippet?: string }, i: number) => (
            <div key={i} className="web-search-result">
              <a href={result.url} target="_blank" rel="noopener noreferrer">{result.title}</a>
              {result.snippet && <p>{result.snippet}</p>}
            </div>
          ))}
        </div>
      );

    default:
      return null;
  }
}

// ============================================================
// Timeline item — tool_use with dot + connector line
// ============================================================

function TimelineItem({
  block,
  isStreaming,
  isFirst,
  isLast: _isLast,
}: {
  block: ContentBlockModel;
  isStreaming: boolean;
  isFirst: boolean;
  isLast: boolean;
}): React.ReactElement | null {
  const { block: content } = block;

  if (content.type === "tool_use" || content.type === "server_tool_use") {
    return (
      <ToolTimelineBlock
        toolName={content.name}
        toolInput={content.input as Record<string, unknown>}
        toolUseId={content.id}
        isStreaming={isStreaming}
        isFirst={isFirst}
      />
    );
  }

  if (content.type === "tool_result") {
    // Tool results are usually paired with their tool_use above
    // They appear as part of a user message — skip standalone rendering
    return null;
  }

  return null;
}

// ============================================================
// Tool timeline block — dot + collapsible header + grid body
// ============================================================

function ToolTimelineBlock({
  toolName,
  toolInput,
  toolUseId,
  isStreaming,
  isFirst,
}: {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  isStreaming: boolean;
  isFirst: boolean;
}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const renderer = getToolRenderer(toolName);

  // Dot status: streaming = progress (blink), done = success
  const dotClass = isStreaming ? "dot-progress" : "dot-success";

  return (
    <div
      className={`timeline-message ${dotClass} ${isFirst ? "timeline-first" : ""}`}
      data-tool-use-id={toolUseId}
    >
      {/* Collapsible header */}
      <div
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        <ChevronIcon className={`chevron ${expanded ? "chevron-expanded" : ""}`} />
        <span className="tool-name-text">{renderer.displayName}</span>
        <span className="tool-name-secondary">{renderer.summary(toolInput)}</span>
      </div>

      {/* Grid body when expanded */}
      {expanded && (
        <div className="tool-body">
          <div className="tool-body-grid">
            {renderer.rows(toolInput).map((row, i) => (
              <div className="tool-body-row" key={i}>
                <div className="tool-body-row-label">{row.label}</div>
                <div className={`tool-body-row-content ${row.expanded ? "tool-body-row-content-expanded" : ""}`}>
                  {row.content}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================
// Thinking block
// ============================================================

function ThinkingBlock({
  thinking,
  isStreaming,
}: {
  thinking: string;
  isStreaming: boolean;
}): React.ReactElement {
  return (
    <details className="thinking-block" open={isStreaming}>
      <summary className="thinking-summary">
        <span className="thinking-dot" />
        <span className="thinking-label">
          {isStreaming ? "Thinking..." : "Thinking"}
        </span>
        <ChevronIcon className="thinking-toggle" />
      </summary>
      <div className="thinking-content">
        <pre>{thinking}</pre>
      </div>
    </details>
  );
}

// ============================================================
// Markdown
// ============================================================

function MarkdownContent({ text }: { text: string }): React.ReactElement {
  const html = renderMarkdown(text);
  return (
    <div
      className="markdown-content"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

// ============================================================
// Chevron icon (12x12, rotates 90deg when expanded)
// ============================================================

function ChevronIcon({ className }: { className?: string }): React.ReactElement {
  return (
    <svg
      className={className}
      width="12"
      height="12"
      viewBox="0 0 16 16"
      fill="currentColor"
    >
      <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

// ============================================================
// Tool renderer definitions
// ============================================================

interface ToolRow {
  label: string;
  content: React.ReactNode;
  expanded?: boolean;
}

interface ToolRendererDef {
  displayName: string;
  summary: (input: Record<string, unknown>) => string;
  rows: (input: Record<string, unknown>) => ToolRow[];
}

function getToolRenderer(toolName: string): ToolRendererDef {
  switch (toolName) {
    case "Bash":
    case "BashTool":
      return {
        displayName: "Bash",
        summary: (input) => {
          const desc = String(input.description ?? "");
          if (desc) return desc;
          const cmd = String(input.command ?? "");
          return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
        },
        rows: (input) => {
          const rows: ToolRow[] = [];
          if (input.description) {
            rows.push({ label: "", content: <span className="tool-description">{String(input.description)}</span> });
          }
          rows.push({
            label: "IN",
            content: <pre className="bash-command">{String(input.command ?? "")}</pre>,
            expanded: true,
          });
          return rows;
        },
      };

    case "Read":
    case "ReadTool":
      return {
        displayName: "Read",
        summary: (input) => {
          const fp = String(input.file_path ?? "");
          return fp.split(/[/\\]/).pop() ?? fp;
        },
        rows: (input) => {
          const rows: ToolRow[] = [
            { label: "IN", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
          ];
          return rows;
        },
      };

    case "Write":
    case "WriteTool":
      return {
        displayName: "Write",
        summary: (input) => {
          const fp = String(input.file_path ?? "");
          return fp.split(/[/\\]/).pop() ?? fp;
        },
        rows: (input) => [
          { label: "IN", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
          {
            label: "content",
            content: (
              <pre className="write-content">
                {String(input.content ?? "").slice(0, 500)}
                {String(input.content ?? "").length > 500 && "\n..."}
              </pre>
            ),
          },
        ],
      };

    case "Edit":
    case "EditTool":
      return {
        displayName: "Edit",
        summary: (input) => {
          const fp = String(input.file_path ?? "");
          return fp.split(/[/\\]/).pop() ?? fp;
        },
        rows: (input) => [
          { label: "IN", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
          {
            label: "diff",
            content: (
              <div className="edit-diff">
                <div className="diff-remove"><pre>- {String(input.old_string ?? "")}</pre></div>
                <div className="diff-insert"><pre>+ {String(input.new_string ?? "")}</pre></div>
              </div>
            ),
            expanded: true,
          },
        ],
      };

    case "Glob":
    case "GlobTool":
      return {
        displayName: "Glob",
        summary: (input) => String(input.pattern ?? ""),
        rows: (input) => [
          { label: "IN", content: <code className="tool-code">{String(input.pattern ?? "")}</code> },
        ],
      };

    case "Grep":
    case "GrepTool":
      return {
        displayName: "Grep",
        summary: (input) => String(input.pattern ?? ""),
        rows: (input) => [
          { label: "IN", content: <code className="tool-code">/{String(input.pattern ?? "")}/</code> },
        ],
      };

    case "ToolSearch":
    case "ToolSearchTool":
      return {
        displayName: "ToolSearch",
        summary: () => "",
        rows: () => [],
      };

    case "TodoWrite":
    case "TodoWriteTool":
      return {
        displayName: "Todo",
        summary: (input) => {
          const todos = input.todos as Array<{ content: string; status: string }> | undefined;
          if (!todos) return "";
          const done = todos.filter((t) => t.status === "completed").length;
          return `${done}/${todos.length} done`;
        },
        rows: (input) => {
          const todos = input.todos as Array<{ content: string; status: string }> | undefined;
          if (!todos) return [];
          return [{
            label: "todos",
            content: (
              <ul className="todo-list">
                {todos.map((todo, i) => (
                  <li key={i} className={`todo-item todo-${todo.status}`}>
                    <span className="todo-checkbox">
                      {todo.status === "completed" ? "✓" : todo.status === "in_progress" ? "●" : "○"}
                    </span>
                    <span className="todo-text">{todo.content}</span>
                  </li>
                ))}
              </ul>
            ),
            expanded: true,
          }];
        },
      };

    case "Agent":
    case "AgentTool":
      return {
        displayName: "Agent",
        summary: (input) => String(input.description ?? ""),
        rows: (input) => [
          { label: "IN", content: <span>{String(input.prompt ?? "").slice(0, 300)}</span> },
        ],
      };

    case "WebSearch":
    case "WebSearchTool":
      return {
        displayName: "Web Search",
        summary: (input) => String(input.query ?? ""),
        rows: (input) => [
          { label: "IN", content: <code className="tool-code">{String(input.query ?? "")}</code> },
        ],
      };

    case "WebFetch":
    case "WebFetchTool":
      return {
        displayName: "Web Fetch",
        summary: (input) => {
          try { return new URL(String(input.url ?? "")).hostname; }
          catch { return String(input.url ?? "").slice(0, 40); }
        },
        rows: (input) => [
          { label: "IN", content: <a href={String(input.url ?? "")} target="_blank" rel="noopener noreferrer">{String(input.url ?? "")}</a> },
        ],
      };

    case "Skill":
    case "SkillTool":
      return {
        displayName: "Skill",
        summary: (input) => `/${String(input.skill ?? "")}`,
        rows: (input) => [
          { label: "IN", content: <code className="tool-code">/{String(input.skill ?? "")}</code> },
        ],
      };

    default:
      return {
        displayName: toolName.replace(/^mcp__\w+__/, ""),
        summary: () => "",
        rows: (input) => [
          { label: "IN", content: <pre style={{ margin: 0 }}>{JSON.stringify(input, null, 2)}</pre>, expanded: true },
        ],
      };
  }
}
