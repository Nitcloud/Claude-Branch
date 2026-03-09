/**
 * Branch Graph types — data models for Task/Branch/Graph system.
 * Implements Git-style context branching for conversations.
 */

// ============================================================
// Task & Branch metadata (stored in .codepilot-meta.json)
// ============================================================

/** Task = a group of related sessions (main + branches) */
export interface TaskInfo {
  /** Primary key — equals the main session's sessionId */
  taskId: string;
  /** User-visible task name */
  taskName: string;
  /** The main branch sessionId */
  mainSessionId: string;
  /** ISO timestamp */
  createdAt: string;
  /** Custom name for the main branch (default: "main") */
  mainBranchName?: string;
}

/** A single incremental merge record */
export interface MergeRecord {
  /** Start user message index in the branch (0-based, inclusive) */
  fromMsgIndex: number;
  /** End user message index in the branch (0-based, inclusive) */
  toMsgIndex: number;
  /** Summary text injected into parent */
  summary: string;
  /** Message index in parent JSONL where summary was injected */
  parentMergeIndex: number;
  /** ISO timestamp */
  timestamp: string;
}

/** Branch metadata for a forked session */
export interface BranchInfo {
  /** Session this branch was forked from (supports nesting) */
  parentSessionId: string;
  /** Message index in parent JSONL where this branch forked */
  forkIndex: number;
  /** Human-readable name, e.g. "fix/approach-B" */
  branchName: string;
  /** ISO timestamp */
  createdAt: string;
  /** Branch lifecycle status */
  status: "active" | "merged" | "deleted";
  /** Nesting depth: 0 = root/main, 1 = direct branch, 2+ = sub-branch */
  depth: number;
  /** Incremental merge history */
  mergeHistory?: MergeRecord[];
}

// ============================================================
// Graph data model (sent to frontend for SVG rendering)
// ============================================================

/**
 * A single node in the conversation graph.
 * Each node corresponds to one user message (analogous to a git commit).
 */
export interface GraphNode {
  /** Global sequential ID within the graph */
  id: number;
  /** Which session this node belongs to */
  sessionId: string;
  /** Message index within the session's JSONL (counts ALL user msgs, for backend ops) */
  messageIndex: number;
  /**
   * Display message index — counts only user messages that have visible text
   * (excludes tool_result-only). Matches ChatView's userMsgIndexMap.
   * Used for scrolling ChatView to the correct message.
   */
  displayMessageIndex: number;
  /** First 80 chars of the user message */
  messagePreview: string;
  /** First 200 chars of the AI reply */
  aiReplyPreview: string;
  /** ISO timestamp */
  timestamp: string;
  /**
   * Parent node IDs. Normally [prevNodeId] for linear flow.
   * Merge nodes have two parents: [mainParent, branchParent].
   */
  parentIds: number[];
  /** Branch name this node belongs to */
  branchName: string;
  /** True if another branch forks from this node */
  isForkPoint: boolean;
  /** True if this node is a merge point */
  isMergePoint: boolean;
  /** True if this is the latest node on the active branch */
  isCurrent: boolean;
}

/** Branch summary within a graph */
export interface GraphBranch {
  sessionId: string;
  name: string;
  status: "active" | "merged" | "deleted";
  depth: number;
}

/** Complete graph data for a single Task */
export interface BranchGraphData {
  taskId: string;
  taskName: string;
  branches: GraphBranch[];
  nodes: GraphNode[];
}

// ============================================================
// Sidebar tree model (3-level: Task → Branch → Turn)
// ============================================================

export interface SidebarTreeNode {
  type: "task" | "branch" | "turn";
  /** taskId / sessionId / "sessionId:msgIndex" */
  id: string;
  /** Display label */
  label: string;
  /** Child nodes */
  children?: SidebarTreeNode[];
  /** For branch/turn: the session this belongs to */
  sessionId?: string;
  /** For turn: message index within the session (raw JSONL, for backend ops) */
  messageIndex?: number;
  /** For turn: display message index (filtered, for ChatView scrolling) */
  displayMessageIndex?: number;
  /** For branch: lifecycle status */
  branchStatus?: "active" | "merged" | "deleted";
}

// ============================================================
// Extended metadata schema (.codepilot-meta.json)
// ============================================================

export interface CodepilotMeta {
  /** Custom session titles (existing) */
  titles?: Record<string, string>;
  /** Custom session ordering (existing) */
  order?: string[];
  /** Task definitions: taskId → TaskInfo */
  tasks?: Record<string, TaskInfo>;
  /** Task display order */
  taskOrder?: string[];
  /** Branch definitions: branchSessionId → BranchInfo */
  branches?: Record<string, BranchInfo>;
}
