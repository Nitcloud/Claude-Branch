/**
 * ToolRenderer — dispatches tool_use content blocks to tool-specific renderers.
 * Uses CSS Grid layout matching the original Claude Code extension.
 */

import React, { useState } from "react";

interface Props {
  toolName: string;
  toolInput: Record<string, unknown>;
  toolUseId: string;
  isStreaming: boolean;
  isServer?: boolean;
  toolResult?: unknown;
}

export function ToolRenderer({
  toolName,
  toolInput,
  toolUseId,
  isStreaming,
  isServer,
  toolResult,
}: Props): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const renderer = getToolRenderer(toolName);

  return (
    <div className="tool-body" data-tool={toolName}>
      {/* Header row */}
      <div
        className="tool-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
      >
        <span className="tool-name-text">{renderer.displayName}</span>
        <span className="tool-name-secondary">{renderer.summary(toolInput)}</span>
        {isStreaming && <span className="tool-spinner" />}
        <span className="tool-expand-arrow">{expanded ? "▾" : "▸"}</span>
      </div>

      {/* Grid body — only when expanded */}
      {expanded && (
        <div className="tool-body-grid">
          {renderer.rows(toolInput).map((row, i) => (
            <div className="tool-body-row" key={i}>
              <div className="tool-body-row-label">{row.label}</div>
              <div className={`tool-body-row-content ${row.expanded ? "tool-body-row-content-expanded" : ""}`}>
                {row.content}
              </div>
            </div>
          ))}
          {toolResult !== undefined && (
            <div className="tool-body-row">
              <div className="tool-body-row-label">output</div>
              <div className="tool-body-row-content tool-body-row-content-expanded">
                <pre style={{ margin: 0, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                  {typeof toolResult === "string"
                    ? toolResult
                    : JSON.stringify(toolResult, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

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
          const cmd = String(input.command ?? "");
          return cmd.length > 80 ? cmd.slice(0, 80) + "..." : cmd;
        },
        rows: (input) => [
          {
            label: "command",
            content: <pre className="bash-command">{String(input.command ?? "")}</pre>,
            expanded: true,
          },
        ],
      };

    case "Read":
    case "ReadTool":
      return {
        displayName: "Read",
        summary: (input) => {
          const fp = String(input.file_path ?? "");
          const name = fp.split(/[/\\]/).pop() ?? fp;
          const range =
            input.offset || input.limit
              ? ` (${input.offset ?? 1}-${(Number(input.offset ?? 1)) + (Number(input.limit ?? 0))})`
              : "";
          return name + range;
        },
        rows: (input) => {
          const rows: ToolRow[] = [
            { label: "file", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
          ];
          if (input.offset) rows.push({ label: "offset", content: String(input.offset) });
          if (input.limit) rows.push({ label: "limit", content: String(input.limit) });
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
          { label: "file", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
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
          { label: "file", content: <span className="file-path">{String(input.file_path ?? "")}</span> },
          {
            label: "diff",
            content: (
              <div className="edit-diff">
                <div className="diff-remove">
                  <pre>- {String(input.old_string ?? "")}</pre>
                </div>
                <div className="diff-insert">
                  <pre>+ {String(input.new_string ?? "")}</pre>
                </div>
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
        rows: (input) => {
          const rows: ToolRow[] = [
            { label: "pattern", content: <code>{String(input.pattern ?? "")}</code> },
          ];
          if (input.path) rows.push({ label: "path", content: String(input.path) });
          return rows;
        },
      };

    case "Grep":
    case "GrepTool":
      return {
        displayName: "Grep",
        summary: (input) => String(input.pattern ?? ""),
        rows: (input) => {
          const rows: ToolRow[] = [
            { label: "pattern", content: <code>/{String(input.pattern ?? "")}/</code> },
          ];
          if (input.path) rows.push({ label: "path", content: String(input.path) });
          if (input.glob) rows.push({ label: "glob", content: String(input.glob) });
          return rows;
        },
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
          if (!todos) return [{ label: "todos", content: "No todos" }];
          return [{
            label: "todos",
            content: (
              <ul className="todo-list">
                {todos.map((todo, i) => (
                  <li key={i} className={`todo-item todo-${todo.status}`}>
                    <span className="todo-checkbox">
                      {todo.status === "completed"
                        ? "✓"
                        : todo.status === "in_progress"
                          ? "●"
                          : "○"}
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
          { label: "task", content: <strong>{String(input.description ?? "")}</strong> },
          {
            label: "prompt",
            content: <pre className="agent-prompt">{String(input.prompt ?? "").slice(0, 300)}</pre>,
          },
        ],
      };

    case "WebSearch":
    case "WebSearchTool":
      return {
        displayName: "Web Search",
        summary: (input) => String(input.query ?? ""),
        rows: (input) => [
          { label: "query", content: <code>{String(input.query ?? "")}</code> },
        ],
      };

    case "WebFetch":
    case "WebFetchTool":
      return {
        displayName: "Web Fetch",
        summary: (input) => {
          try {
            return new URL(String(input.url ?? "")).hostname;
          } catch {
            return String(input.url ?? "").slice(0, 40);
          }
        },
        rows: (input) => {
          const rows: ToolRow[] = [
            {
              label: "url",
              content: (
                <a href={String(input.url ?? "")} target="_blank" rel="noopener noreferrer">
                  {String(input.url ?? "")}
                </a>
              ),
            },
          ];
          if (input.prompt) rows.push({ label: "prompt", content: String(input.prompt) });
          return rows;
        },
      };

    case "Skill":
    case "SkillTool":
      return {
        displayName: "Skill",
        summary: (input) => `/${String(input.skill ?? "")}`,
        rows: (input) => {
          const rows: ToolRow[] = [
            { label: "skill", content: <code>/{String(input.skill ?? "")}</code> },
          ];
          if (input.args) rows.push({ label: "args", content: String(input.args) });
          return rows;
        },
      };

    default:
      // Generic MCP or unknown tool
      return {
        displayName: toolName.replace(/^mcp__\w+__/, ""),
        summary: () => "",
        rows: (input) => [
          {
            label: "input",
            content: <pre style={{ margin: 0 }}>{JSON.stringify(input, null, 2)}</pre>,
            expanded: true,
          },
        ],
      };
  }
}
