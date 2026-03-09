/**
 * postMessage types between Extension Host and Webview.
 * Extension -> Webview: { type: "from-extension", message: ExtensionToWebview }
 * Webview -> Extension: WebviewToExtension
 */

import type { CliOutput, ContentBlock } from "./cli-protocol";
import type { BranchGraphData, MergeRecord, SidebarTreeNode } from "./branch-graph";

// ============================================================
// Extension -> Webview
// ============================================================

export type ExtensionToWebview =
  | IoMessage
  | ReplayBatchMessage
  | CloseChannelMessage
  | FileUpdatedMessage
  | IncomingRequestMessage
  | IncomingResponseMessage
  | CancelRequestMessage
  | SpeechToTextMessage
  | PlanCommentMessage;

export interface IoMessage {
  type: "io_message";
  channelId: string;
  message: CliOutput;
  done: boolean;
}

/** Chunk of historical messages replayed from a JSONL session file. */
export interface ReplayBatchMessage {
  type: "replay_batch";
  channelId: string;
  messages: CliOutput[];
  /** True when this is the last chunk — triggers rendering. */
  isLast: boolean;
  /** Total message count across all chunks. */
  totalCount: number;
}

export interface CloseChannelMessage {
  type: "close_channel";
  channelId: string;
  error?: string;
}

export interface FileUpdatedMessage {
  type: "file_updated";
  channelId: string;
  filePath: string;
  oldContent: string | null;
  newContent: string | null;
}

export interface IncomingRequestMessage {
  type: "request";
  channelId: string;
  requestId: string;
  request: IncomingRequest;
}

export interface IncomingResponseMessage {
  type: "response";
  requestId: string;
  response: unknown;
}

export interface CancelRequestMessage {
  type: "cancel_request";
  targetRequestId: string;
}

export interface SpeechToTextMessage {
  type: "speech_to_text_message";
  channelId: string;
  text: string;
  done: boolean;
}

export interface PlanCommentMessage {
  type: "plan_comment";
  channelId: string;
  comment: {
    text: string;
    selectedText: string;
  };
}

// ============================================================
// Webview -> Extension
// ============================================================

export type WebviewToExtension =
  | LaunchClaudeMessage
  | CloseChannelOutMessage
  | InterruptClaudeMessage
  | IoOutMessage
  | OutgoingRequestMessage
  | OutgoingResponseMessage
  | CancelRequestOutMessage
  | StartSpeechMessage
  | StopSpeechMessage;

export interface LaunchClaudeMessage {
  type: "launch_claude";
  channelId: string;
  resume?: string;
  cwd?: string;
  model?: string;
  permissionMode?: string;
  thinkingLevel?: string;
  initialPrompt?: string;
  sessionId?: string;
  agent?: string;
  /** When true, bridge skips replaySessionHistory (client already loaded history). */
  skipReplay?: boolean;
}

export interface CloseChannelOutMessage {
  type: "close_channel";
  channelId: string;
}

export interface InterruptClaudeMessage {
  type: "interrupt_claude";
  channelId: string;
}

export interface IoOutMessage {
  type: "io_message";
  channelId: string;
  message: {
    type: "user";
    session_id: string;
    message: { role: "user"; content: ContentBlock[] };
    parent_tool_use_id: string | null;
  };
  done: boolean;
}

export interface OutgoingRequestMessage {
  type: "request";
  channelId?: string;
  requestId: string;
  request: OutgoingRequest;
}

export interface OutgoingResponseMessage {
  type: "response";
  requestId: string;
  response: unknown;
}

export interface CancelRequestOutMessage {
  type: "cancel_request";
  targetRequestId: string;
}

export interface StartSpeechMessage {
  type: "start_speech_to_text";
  channelId: string;
}

export interface StopSpeechMessage {
  type: "stop_speech_to_text";
  channelId: string;
}

// ============================================================
// Request types (outgoing from webview)
// ============================================================

export type OutgoingRequest =
  | { type: "init" }
  | { type: "get_claude_state" }
  | { type: "list_sessions_request" }
  | { type: "get_session_request"; sessionId: string }
  | { type: "delete_session"; sessionId: string }
  | { type: "rename_session"; sessionId: string; name: string }
  | { type: "reorder_sessions"; sessionIds: string[] }
  | { type: "fork_conversation"; channelId: string }
  | { type: "teleport_session"; sessionId: string }
  | { type: "open_file"; filePath: string; location?: { line?: number; column?: number; startText?: string; endText?: string } }
  | { type: "open_diff"; originalFilePath: string; newFilePath: string; edits: DiffEdit[]; supportMultiEdits: boolean }
  | { type: "open_content"; content: string; fileName: string; editable: boolean }
  | { type: "open_file_diffs"; sessionId: string }
  | { type: "open_markdown_preview"; content: string; title: string }
  | { type: "close_plan_preview" }
  | { type: "list_files_request"; pattern: string }
  | { type: "set_permission_mode"; mode: string }
  | { type: "set_model"; model: string }
  | { type: "set_thinking_level"; thinkingLevel: string }
  | { type: "apply_settings"; settings: Record<string, unknown> }
  | { type: "request_usage_update" }
  | { type: "login"; method: string }
  | { type: "submit_oauth_code"; code: string }
  | { type: "log_event"; event: string; data?: unknown }
  | { type: "show_notification"; level: "info" | "warning" | "error"; message: string; buttons?: string[] }
  | { type: "new_conversation_tab"; sessionId?: string; initialPrompt?: string }
  | { type: "open_in_editor"; sessionId: string }
  | { type: "rename_tab"; channelId: string; title: string; iconState?: "pending" | "done" | "normal" }
  | { type: "update_session_state"; channelId: string; state: SessionState }
  | { type: "get_current_selection" }
  | { type: "get_asset_uris"; assets: string[] }
  | { type: "open_config" }
  | { type: "open_config_file"; scope: string }
  | { type: "open_help" }
  | { type: "open_url"; url: string }
  | { type: "open_output_panel" }
  | { type: "open_folder"; folderPath: string }
  | { type: "open_terminal"; command?: string }
  | { type: "get_terminal_contents"; terminalId?: string }
  | { type: "open_claude_in_terminal" }
  | { type: "get_mcp_servers" }
  | { type: "set_mcp_server_enabled"; serverName: string; enabled: boolean }
  | { type: "reconnect_mcp_server"; serverName: string }
  | { type: "authenticate_mcp_server"; serverName: string }
  | { type: "clear_mcp_server_auth"; serverName: string }
  | { type: "submit_mcp_oauth_callback_url"; callbackUrl: string }
  | { type: "list_plugins" }
  | { type: "install_plugin"; pluginId: string; marketplace: string }
  | { type: "uninstall_plugin"; pluginId: string }
  | { type: "set_plugin_enabled"; pluginId: string; enabled: boolean }
  | { type: "dismiss_onboarding" }
  | { type: "rewind_code"; sessionId: string; messageIndex: number }
  | { type: "check_git_status" }
  | { type: "remove_plan_comment"; channelId: string; commentIndex: number }
  | { type: "exec"; command: string }
  // ── Branch Graph requests ──
  | { type: "create_task"; taskName: string }
  | { type: "rename_task"; taskId: string; name: string }
  | { type: "delete_task"; taskId: string }
  | { type: "reorder_tasks"; taskIds: string[] }
  | { type: "create_branch"; parentSessionId: string; forkIndex: number; branchName: string }
  | { type: "rename_branch"; branchSessionId: string; name: string }
  | { type: "merge_branch"; branchSessionId: string; mergeSummary: string; fromMsgIndex: number; toMsgIndex: number }
  | { type: "delete_branch"; branchSessionId: string }
  | { type: "fork_and_rewind"; sessionId: string; forkIndex: number; branchName: string }
  | { type: "rollback_session"; sessionId: string; targetIndex: number }
  | { type: "get_branch_graph"; taskId: string }
  | { type: "get_merge_preview"; branchSessionId: string; fromMsgIndex?: number; toMsgIndex?: number }
  | { type: "generate_merge_summary"; branchSessionId: string; fromMsgIndex: number; toMsgIndex: number }
  | { type: "get_sidebar_tree" }
  | { type: "get_session_messages"; sessionId: string }
  | { type: "move_session_to_task"; sessionId: string; targetTaskId: string }
  | { type: "create_task_from_session"; sessionId: string; taskName: string }
  | { type: "import_session_to_task"; sessionId: string; targetTaskId: string; branchName: string }
  | { type: "list_importable_sessions" };

export interface DiffEdit {
  oldString: string;
  newString: string;
  replaceAll?: boolean;
}

export interface SessionState {
  status: "idle" | "streaming" | "waiting_input" | "tool_use" | "error";
  title?: string;
  model?: string;
}

// ============================================================
// Incoming request types (from extension to webview)
// ============================================================

export type IncomingRequest =
  | { type: "tool_permission_request"; toolName: string; toolInput: Record<string, unknown>; suggestions: unknown[]; description?: string; requestId: string }
  | { type: "insert_at_mention"; text: string }
  | { type: "visibility_changed"; visible: boolean }
  | { type: "font_configuration_changed"; config: FontConfig }
  | { type: "create_new_conversation" }
  | { type: "selection_changed"; selection: EditorSelection | null };

export interface FontConfig {
  fontSize?: number;
  fontFamily?: string;
  editorFontSize?: number;
  editorFontFamily?: string;
  editorFontWeight?: string;
}

export interface EditorSelection {
  fileName: string;
  relativePath: string;
  languageId: string;
  selectedText: string;
  startLine: number;
  endLine: number;
}

// ============================================================
// Branch Graph response types
// ============================================================

export interface CreateTaskResponse {
  taskId: string;
  mainSessionId: string;
}

export interface CreateBranchResponse {
  branchSessionId: string;
}

export interface MergePreviewResponse {
  /** Extracted assistant text from branch (for the requested range) */
  branchContent: string;
  /** Number of turns in the requested range */
  turnCount: number;
  /** Next available merge start index (after last merge, or 0) */
  availableFromIndex: number;
  /** Total user message count in the branch */
  totalMsgCount: number;
  /** Existing merge history */
  mergeHistory: MergeRecord[];
}

export interface GenerateMergeSummaryResponse {
  summary: string;
}

export interface BranchGraphResponse {
  graph: BranchGraphData;
}

export interface SidebarTreeResponse {
  tree: SidebarTreeNode[];
}

export interface SessionMessagesResponse {
  messages: CliOutput[];
}
