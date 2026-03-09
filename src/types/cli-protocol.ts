/**
 * CLI stdin/stdout JSON message types.
 * claude.exe uses --input-format stream-json --output-format stream-json
 * Communication is newline-delimited JSON (NDJSON).
 */

// ============================================================
// Content block types (shared between user/assistant messages)
// ============================================================

export interface TextContent {
  type: "text";
  text: string;
  citations?: Citation[];
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  signature?: string;
}

export interface RedactedThinkingContent {
  type: "redacted_thinking";
  data: string;
}

export interface ToolUseContent {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ServerToolUseContent {
  type: "server_tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ToolResultContent {
  type: "tool_result";
  tool_use_id: string;
  content: string | ContentBlock[];
  is_error?: boolean;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
}

export interface DocumentContent {
  type: "document";
  source: {
    type: "base64";
    media_type: string;
    data: string;
  };
  title?: string;
}

export interface WebSearchResultContent {
  type: "web_search_tool_result";
  search_results: Array<{
    title: string;
    url: string;
    snippet?: string;
  }>;
}

export interface Citation {
  type: string;
  cited_text?: string;
  url?: string;
  title?: string;
  start_block_index?: number;
  end_block_index?: number;
}

export type ContentBlock =
  | TextContent
  | ThinkingContent
  | RedactedThinkingContent
  | ToolUseContent
  | ServerToolUseContent
  | ToolResultContent
  | ImageContent
  | DocumentContent
  | WebSearchResultContent;

// ============================================================
// Messages TO CLI (written to stdin)
// ============================================================

export interface CliUserInput {
  type: "user";
  session_id: string;
  message: {
    role: "user";
    content: ContentBlock[];
  };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
}

export interface CliControlResponse {
  type: "control_response";
  response: {
    subtype: "success" | "error";
    request_id: string;
    response?: unknown;
    error?: string;
  };
}

export type CliInput = CliUserInput | CliControlResponse;

// ============================================================
// Messages FROM CLI (read from stdout)
// ============================================================

export interface CliStreamEvent {
  type: "stream_event";
  event: AnthropicSSEvent;
  parent_tool_use_id?: string;
}

export interface CliAssistantMessage {
  type: "assistant";
  uuid: string;
  session_id: string;
  message: {
    role: "assistant";
    id: string;
    model: string;
    content: ContentBlock[];
    usage: TokenUsage;
    stop_reason?: string;
  };
  parent_tool_use_id: string | null;
  error?: string;
}

export interface CliUserMessage {
  type: "user";
  uuid: string;
  session_id: string;
  message: {
    role: "user";
    content: ContentBlock[];
  };
  parent_tool_use_id: string | null;
  isSynthetic?: boolean;
}

export interface CliSystemMessage {
  type: "system";
  subtype:
    | "init"
    | "status"
    | "compact_boundary"
    | "task_started"
    | "task_progress"
    | "task_notification";
  session_id?: string;
  model?: string;
  fast_mode_state?: string;
  tools?: string[];
  mcp_servers?: unknown[];
  // compact_boundary fields
  compact_metadata?: CompactMetadata;
  // status fields
  status?: string;
  permissionMode?: string;
}

export interface CompactMetadata {
  trigger: "manual" | "auto";
  pre_tokens: number;
  uuid: string;
  compactSummary?: string;
}

export interface CliResult {
  type: "result";
  total_cost_usd?: number;
  modelUsage?: Record<
    string,
    { contextWindow: number; maxOutputTokens: number }
  >;
  fast_mode_state?: string;
  session_id?: string;
  is_error?: boolean;
}

export interface CliControlRequest {
  type: "control_request";
  request_id: string;
  // Permission request
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  suggestions?: PermissionSuggestion[];
  description?: string;
  // Hook callback
  hook_event_name?: string;
  hook_data?: unknown;
  // MCP message
  mcp_server_name?: string;
  mcp_message?: unknown;
  // Elicitation
  elicitation?: unknown;
}

export interface CliControlCancelRequest {
  type: "control_cancel_request";
  request_id: string;
}

export interface CliKeepAlive {
  type: "keep_alive";
}

export interface CliToolPermissionRequest {
  type: "tool_permission_request";
  tool_name: string;
  tool_input: Record<string, unknown>;
  suggestions: PermissionSuggestion[];
  description?: string;
  request_id: string;
}

export interface PermissionSuggestion {
  label: string;
  value: string;
  description?: string;
}

export type CliOutput =
  | CliStreamEvent
  | CliAssistantMessage
  | CliUserMessage
  | CliSystemMessage
  | CliResult
  | CliControlRequest
  | CliControlCancelRequest
  | CliKeepAlive
  | CliToolPermissionRequest;

// ============================================================
// Anthropic SSE types
// ============================================================

export interface AnthropicSSEvent {
  type: string;
  // message_start
  message?: {
    id: string;
    role: string;
    model: string;
    content: ContentBlock[];
    usage: TokenUsage;
    stop_reason?: string;
  };
  // content_block_start
  index?: number;
  content_block?: ContentBlock;
  // content_block_delta
  delta?: ContentDelta;
  // message_delta
  usage?: TokenUsage;
}

export interface ContentDelta {
  type: string;
  text?: string;
  partial_json?: string;
  thinking?: string;
  signature?: string;
  citations?: Citation[];
}

export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  server_tool_use_input_tokens?: number;
}
