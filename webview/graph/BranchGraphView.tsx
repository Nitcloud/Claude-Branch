/**
 * BranchGraphView — single-page view: left sidebar + right upper/lower split.
 *
 * Layout:
 * ┌──────────────┬──────────────────────────────────────────────┐
 * │ SidebarTree  │ GraphControls                                │
 * │              ├──────────────────────────────────────────────┤
 * │              │ Upper: SVG Graph + Table                     │
 * │              ├──────────────────────────────────────────────┤
 * │              │ Lower: ChatView (full interactive chat)      │
 * └──────────────┴──────────────────────────────────────────────┘
 *
 * The lower panel embeds ChatView directly — no page switching needed.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import type {
  BranchGraphData,
  GraphNode,
  SidebarTreeNode,
} from "../../src/types/branch-graph";
import type {
  BranchGraphResponse,
  SidebarTreeResponse,
  CreateBranchResponse,
  CreateTaskResponse,
} from "../../src/types/webview-protocol";
import { getConnection } from "../connection/Connection";
import { SidebarTree } from "./SidebarTree";
import { GraphControls } from "./GraphControls";
import { GraphTable } from "./GraphTable";
import { MergeDialog } from "./MergeDialog";
import { ChatView } from "../chat/ChatView";

export function BranchGraphView(): React.ReactElement {
  const conn = getConnection();

  // ── State ──
  const [sidebarTree, setSidebarTree] = useState<SidebarTreeNode[]>([]);
  const [graphData, setGraphData] = useState<BranchGraphData | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [viewBranchId, setViewBranchId] = useState<string | null>(null);
  const [visibleBranchIds, setVisibleBranchIds] = useState<string[] | null>(null);
  const [highlightedNodeIndex, setHighlightedNodeIndex] = useState<number | undefined>();
  const [mergeTarget, setMergeTarget] = useState<{
    sessionId: string;
    name: string;
    preselectedTurnIndex?: number;
  } | null>(null);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [dividerY, setDividerY] = useState(300);
  const [sidebarWidth, setSidebarWidth] = useState(220);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Key to force ChatView remount when switching branches */
  const [chatKey, setChatKey] = useState(0);
  /** Scroll request for ChatView — { index, seq } */
  const [scrollToMsg, setScrollToMsg] = useState<{ index: number; seq: number } | undefined>();
  const scrollSeqRef = useRef(0);

  // ── Data loading ──

  const loadSidebarTree = useCallback(async () => {
    try {
      console.log("[Graph] Loading sidebar tree...");
      const result = await conn.sendRequest<SidebarTreeResponse>({
        type: "get_sidebar_tree",
      });
      console.log("[Graph] Sidebar tree loaded:", result.tree?.length, "tasks");
      setSidebarTree(result.tree || []);
      return result.tree || [];
    } catch (err) {
      console.error("[Graph] Failed to load sidebar tree:", err);
      return [];
    }
  }, [conn]);

  const loadGraph = useCallback(
    async (taskId: string) => {
      setLoading(true);
      setLoadError(null);
      try {
        console.log("[Graph] Loading graph for task:", taskId);
        const result = await conn.sendRequest<BranchGraphResponse>({
          type: "get_branch_graph",
          taskId,
        });
        console.log("[Graph] Graph loaded:", result.graph?.nodes?.length, "nodes");
        if (result.graph) {
          // Defensive: ensure nodes and branches are always arrays
          const graph = result.graph;
          if (!Array.isArray(graph.nodes)) graph.nodes = [];
          if (!Array.isArray(graph.branches)) graph.branches = [];
          setGraphData(graph);
        } else {
          // Response was an error object like { error: "..." }
          console.error("[Graph] Invalid graph response:", result);
          setGraphData({ taskId, taskName: "", branches: [], nodes: [] });
        }
      } catch (err) {
        console.error("[Graph] Failed to load graph:", err);
        setLoadError(String(err));
        setGraphData({ taskId, taskName: "", branches: [], nodes: [] });
      } finally {
        setLoading(false);
      }
    },
    [conn]
  );

  // ── Initial load ──

  useEffect(() => {
    (async () => {
      const tree = await loadSidebarTree();
      if (tree.length > 0 && !activeTaskId) {
        const firstTaskId = tree[0].id;
        setActiveTaskId(firstTaskId);
        await loadGraph(firstTaskId);
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Event handlers: state machine ──

  const handleSelectTask = useCallback(
    async (taskId: string) => {
      setActiveTaskId(taskId);
      setVisibleBranchIds(null);
      setHighlightedNodeIndex(undefined);
      setViewBranchId(null);
      await loadGraph(taskId);
    },
    [loadGraph]
  );

  const handleSelectBranch = useCallback(
    async (taskId: string, sessionId: string) => {
      if (taskId !== activeTaskId) {
        setActiveTaskId(taskId);
        await loadGraph(taskId);
      }
      setViewBranchId(sessionId);
      setChatKey((k) => k + 1);
      setHighlightedNodeIndex(undefined);
    },
    [activeTaskId, loadGraph]
  );

  const handleSelectTurn = useCallback(
    async (taskId: string, sessionId: string, messageIndex: number, displayMessageIndex: number) => {
      if (taskId !== activeTaskId) {
        setActiveTaskId(taskId);
        await loadGraph(taskId);
      }
      if (sessionId !== viewBranchId) {
        setViewBranchId(sessionId);
        setChatKey((k) => k + 1);
      }

      // Scroll ChatView — use displayMessageIndex (matches ChatView's userMsgIndexMap)
      scrollSeqRef.current++;
      setScrollToMsg({ index: displayMessageIndex, seq: scrollSeqRef.current });

      if (graphData) {
        const globalIdx = (graphData.nodes ?? [])
          .slice()
          .sort((a, b) => b.id - a.id)
          .findIndex(
            (n) => n.sessionId === sessionId && n.messageIndex === messageIndex
          );
        setHighlightedNodeIndex(globalIdx >= 0 ? globalIdx : undefined);
      }
    },
    [activeTaskId, loadGraph, graphData, viewBranchId]
  );

  const handleNodeClick = useCallback(
    (node: GraphNode) => {
      if (node.sessionId !== viewBranchId) {
        setViewBranchId(node.sessionId);
        setChatKey((k) => k + 1);
      }
      // Scroll ChatView — use displayMessageIndex (matches ChatView's userMsgIndexMap)
      scrollSeqRef.current++;
      setScrollToMsg({ index: node.displayMessageIndex, seq: scrollSeqRef.current });

      if (graphData) {
        const sorted = (graphData.nodes ?? []).slice().sort((a, b) => b.id - a.id);
        setHighlightedNodeIndex(sorted.findIndex((n) => n.id === node.id));
      }
    },
    [graphData, viewBranchId]
  );

  const handleRefresh = useCallback(async () => {
    const tree = await loadSidebarTree();
    if (activeTaskId) {
      await loadGraph(activeTaskId);
    } else if (tree.length > 0) {
      const firstTaskId = tree[0].id;
      setActiveTaskId(firstTaskId);
      await loadGraph(firstTaskId);
    }
  }, [loadSidebarTree, loadGraph, activeTaskId]);

  // ── Branch/Rollback from graph context menu ──

  const handleBranchFromHere = useCallback(
    async (node: GraphNode) => {
      const branchName = `branch-${Date.now()}`;
      await conn.sendRequest<CreateBranchResponse>({
        type: "create_branch",
        parentSessionId: node.sessionId,
        forkIndex: node.messageIndex,
        branchName,
      });
      await handleRefresh();
    },
    [conn, handleRefresh]
  );

  const handleRewindToHere = useCallback(
    async (node: GraphNode) => {
      await conn.sendRequest({
        type: "rollback_session",
        sessionId: node.sessionId,
        targetIndex: node.messageIndex,
      });
      await handleRefresh();
    },
    [conn, handleRefresh]
  );

  const handleForkAndRewind = useCallback(
    async (node: GraphNode) => {
      const branchName = `fork-${Date.now()}`;
      await conn.sendRequest({
        type: "fork_and_rewind",
        sessionId: node.sessionId,
        forkIndex: node.messageIndex,
        branchName,
      });
      await handleRefresh();
    },
    [conn, handleRefresh]
  );

  const handleDeleteTurn = useCallback(
    async (node: GraphNode) => {
      await conn.sendRequest({
        type: "delete_turn",
        sessionId: node.sessionId,
        targetIndex: node.messageIndex,
      });
      await handleRefresh();
    },
    [conn, handleRefresh]
  );

  const handleDeleteTurnDirect = useCallback(
    async (sessionId: string, messageIndex: number) => {
      await conn.sendRequest({
        type: "delete_turn",
        sessionId,
        targetIndex: messageIndex,
      });
      await handleRefresh();
    },
    [conn, handleRefresh]
  );

  // ── Controls callbacks ──

  const handleToggleBranchVisibility = useCallback(
    (sessionIds: string[] | null) => {
      setVisibleBranchIds(sessionIds);
    },
    []
  );

  const handleSelectViewBranch = useCallback((sessionId: string) => {
    setViewBranchId(sessionId);
    setChatKey((k) => k + 1);
    setHighlightedNodeIndex(undefined);
  }, []);

  // ── Divider drag ──

  const isDraggingDivider = useRef(false);
  const rightPanelRef = useRef<HTMLDivElement>(null);

  const handleDividerMouseDown = useCallback(() => {
    isDraggingDivider.current = true;
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingDivider.current || !rightPanelRef.current) return;
      const rect = rightPanelRef.current.getBoundingClientRect();
      const newY = e.clientY - rect.top;
      setDividerY(Math.max(100, Math.min(newY, rect.height - 100)));
    };

    const handleMouseUp = () => {
      isDraggingDivider.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  // ── Sidebar resize drag ──

  const isDraggingSidebar = useRef(false);

  const handleSidebarResizeMouseDown = useCallback(() => {
    isDraggingSidebar.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const handleMouseMove = (e: MouseEvent) => {
      if (!isDraggingSidebar.current) return;
      setSidebarWidth(Math.max(140, Math.min(e.clientX, 500)));
    };

    const handleMouseUp = () => {
      isDraggingSidebar.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  }, []);

  // ── Build tasks list for controls ──

  const tasks = sidebarTree.map((t) => ({
    taskId: t.id,
    taskName: t.label,
  }));

  // ── Check if graph is empty (no nodes) ──
  // Defensive: graphData.nodes might be undefined if bridge returns incomplete data
  const graphNodes = graphData?.nodes ?? [];
  const graphBranches = graphData?.branches ?? [];
  const graphIsEmpty = graphData && graphNodes.length === 0;
  const noTasks = sidebarTree.length === 0;

  return (
    <div className="branch-graph-view">
      {/* Left sidebar */}
      <div className="branch-graph-sidebar" style={{ width: sidebarWidth }}>
        <SidebarTree
          tree={sidebarTree}
          activeTaskId={activeTaskId}
          activeSessionId={viewBranchId}
          onSelectTask={handleSelectTask}
          onSelectBranch={handleSelectBranch}
          onSelectTurn={handleSelectTurn}
          onRefresh={handleRefresh}
          onImportSession={() => setShowImportDialog(true)}
          onMerge={(target) => setMergeTarget(target)}
          onMergeTurn={(target) =>
            setMergeTarget({
              sessionId: target.sessionId,
              name: target.branchName,
              preselectedTurnIndex: target.turnMsgIndex,
            })
          }
          onDeleteTurn={handleDeleteTurnDirect}
        />
      </div>

      {/* Sidebar resize handle */}
      <div
        className="branch-graph-sidebar-resize"
        onMouseDown={handleSidebarResizeMouseDown}
      />

      {/* Right panel */}
      <div className="branch-graph-main" ref={rightPanelRef}>
        {/* Controls bar */}
        <GraphControls
          tasks={tasks}
          activeTaskId={activeTaskId}
          branches={graphBranches}
          visibleBranchIds={visibleBranchIds}
          viewBranchId={viewBranchId}
          onSelectTask={handleSelectTask}
          onToggleBranchVisibility={handleToggleBranchVisibility}
          onSelectViewBranch={handleSelectViewBranch}
          onRefresh={handleRefresh}
        />

        {/* Upper panel: SVG Graph + Table */}
        <div className="branch-graph-upper" style={{ height: dividerY }}>
          {loading && <div className="graph-loading">Loading graph...</div>}
          {loadError && !loading && (
            <div className="graph-empty-state">
              <div className="graph-empty-title">Failed to load graph</div>
              <div className="graph-empty-hint">
                <p>{loadError}</p>
                <div className="graph-empty-actions">
                  <button className="graph-action-btn graph-action-primary" onClick={handleRefresh}>
                    Retry
                  </button>
                </div>
              </div>
            </div>
          )}

          {graphData && !loading && !graphIsEmpty && (
            <GraphTable
              graphData={graphData}
              visibleBranchIds={visibleBranchIds}
              onNodeClick={handleNodeClick}
              onBranchFromHere={handleBranchFromHere}
              onRewindToHere={handleRewindToHere}
              onForkAndRewind={handleForkAndRewind}
              onDeleteTurn={handleDeleteTurn}
              highlightedNodeIndex={highlightedNodeIndex}
            />
          )}

          {(noTasks || graphIsEmpty) && !loading && (
            <div className="graph-empty-state">
              <div className="graph-empty-title">
                {noTasks
                  ? "No tasks yet"
                  : "This task has no conversations yet"}
              </div>
              <div className="graph-empty-hint">
                {noTasks ? (
                  <>
                    <p>Get started by importing an existing session or creating a new task:</p>
                    <div className="graph-empty-actions">
                      <button
                        className="graph-action-btn graph-action-primary"
                        onClick={() => setShowImportDialog(true)}
                      >
                        Import Existing Session
                      </button>
                      <button
                        className="graph-action-btn"
                        onClick={async () => {
                          const name = `Task ${sidebarTree.length + 1}`;
                          await conn.sendRequest<CreateTaskResponse>({
                            type: "create_task",
                            taskName: name,
                          });
                          await handleRefresh();
                        }}
                      >
                        New Empty Task
                      </button>
                    </div>
                  </>
                ) : (
                  <p>Start a conversation in the panel below, or create a branch.</p>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Divider */}
        <div className="branch-graph-divider" onMouseDown={handleDividerMouseDown} />

        {/* Lower panel: Interactive ChatView */}
        <div className="branch-graph-lower">
          {viewBranchId ? (
            <ChatView
              key={`${viewBranchId}-${chatKey}`}
              resumeSessionId={viewBranchId}
              lazyLaunch
              scrollToMessage={scrollToMsg}
              onTurnComplete={handleRefresh}
            />
          ) : (
            <div className="graph-empty">
              Select a branch to start chatting.
            </div>
          )}
        </div>
      </div>

      {/* Merge dialog */}
      {mergeTarget && (
        <MergeDialog
          branchSessionId={mergeTarget.sessionId}
          branchName={mergeTarget.name}
          preselectedTurnIndex={mergeTarget.preselectedTurnIndex}
          onClose={() => setMergeTarget(null)}
          onMerged={() => {
            setMergeTarget(null);
            handleRefresh();
          }}
        />
      )}

      {/* Import session dialog */}
      {showImportDialog && (
        <ImportSessionDialog
          activeTaskId={activeTaskId}
          onClose={() => setShowImportDialog(false)}
          onImported={async () => {
            setShowImportDialog(false);
            await handleRefresh();
          }}
        />
      )}
    </div>
  );
}

// ── Import session dialog ──

function ImportSessionDialog({
  activeTaskId,
  onClose,
  onImported,
}: {
  activeTaskId: string | null;
  onClose: () => void;
  onImported: () => void;
}): React.ReactElement {
  const conn = getConnection();
  const [sessions, setSessions] = useState<
    Array<{ sessionId: string; title: string; messageCount: number }>
  >([]);
  const [loading, setLoading] = useState(true);
  const [importing, setImporting] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const result = await conn.sendRequest<{
          sessions: Array<{ sessionId: string; title: string; messageCount: number }>;
        }>({ type: "list_importable_sessions" });
        setSessions(result.sessions);
      } catch (err) {
        console.error("Failed to list sessions:", err);
      } finally {
        setLoading(false);
      }
    })();
  }, [conn]);

  const handleImport = async (sessionId: string, title: string) => {
    setImporting(sessionId);
    try {
      if (activeTaskId) {
        // Import as a branch into the active task
        await conn.sendRequest({
          type: "import_session_to_task",
          sessionId,
          targetTaskId: activeTaskId,
          branchName: title,
        });
      } else {
        // No active task — create a new task with this session as main
        await conn.sendRequest({
          type: "create_task_from_session",
          sessionId,
          taskName: title,
        });
      }
      onImported();
    } catch (err) {
      console.error("Failed to import session:", err);
      setImporting(null);
    }
  };

  return (
    <div className="merge-dialog-overlay" onClick={onClose}>
      <div className="merge-dialog" onClick={(e) => e.stopPropagation()} style={{ width: 600 }}>
        <div className="merge-dialog-header">
          <h3>{activeTaskId ? "Import Session as Branch" : "Import Session as Task"}</h3>
          <button className="merge-dialog-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {loading ? (
          <div className="merge-dialog-loading">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="import-empty">
            No importable sessions found. All sessions are already part of tasks,
            or there are no sessions yet.
          </div>
        ) : (
          <div className="import-session-list">
            {sessions.map((s) => (
              <div key={s.sessionId} className="import-session-item">
                <div className="import-session-info">
                  <div className="import-session-title">{s.title}</div>
                  <div className="import-session-meta">
                    {s.messageCount} messages
                  </div>
                </div>
                <button
                  className="graph-action-btn graph-action-primary"
                  onClick={() => handleImport(s.sessionId, s.title)}
                  disabled={importing !== null}
                >
                  {importing === s.sessionId ? "Importing..." : "Import"}
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
