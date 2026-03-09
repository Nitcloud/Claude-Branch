/**
 * SidebarTree — 3-level tree navigation: Task → Branch → Turn.
 * Supports drag-reorder of tasks, right-click context menus.
 */

import React, { useState, useCallback, useRef } from "react";
import type { SidebarTreeNode } from "../../src/types/branch-graph";
import { getConnection } from "../connection/Connection";

export interface SidebarTreeProps {
  tree: SidebarTreeNode[];
  activeTaskId: string | null;
  activeSessionId: string | null;
  onSelectTask: (taskId: string) => void;
  onSelectBranch: (taskId: string, sessionId: string) => void;
  onSelectTurn: (taskId: string, sessionId: string, messageIndex: number, displayMessageIndex: number) => void;
  onRefresh: () => void;
  onImportSession?: () => void;
  onMerge?: (target: { sessionId: string; name: string }) => void;
  onMergeTurn?: (target: { sessionId: string; turnMsgIndex: number; branchName: string }) => void;
  onDeleteTurn?: (sessionId: string, messageIndex: number) => void;
}

export function SidebarTree({
  tree,
  activeTaskId,
  activeSessionId,
  onSelectTask,
  onSelectBranch,
  onSelectTurn,
  onRefresh,
  onImportSession,
  onMerge,
  onMergeTurn,
  onDeleteTurn,
}: SidebarTreeProps): React.ReactElement {
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [expandedBranches, setExpandedBranches] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: SidebarTreeNode;
    taskId?: string;
  } | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; type: "task" | "branch" } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameValueRef = useRef("");
  const isCommittingRef = useRef(false);
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);

  const conn = getConnection();

  // ── Expand/Collapse ──

  const toggleTask = useCallback((taskId: string) => {
    setExpandedTasks((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }, []);

  const toggleBranch = useCallback((sessionId: string) => {
    setExpandedBranches((prev) => {
      const next = new Set(prev);
      if (next.has(sessionId)) next.delete(sessionId);
      else next.add(sessionId);
      return next;
    });
  }, []);

  // ── Context Menu ──

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: SidebarTreeNode, taskId?: string) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, node, taskId });
    },
    []
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleRename = useCallback(
    (nodeType: "task" | "branch", id: string) => {
      closeContextMenu();
      isCommittingRef.current = false;
      setRenaming({ id, type: nodeType });
      const node = findNode(tree, id);
      const label = node?.label || "";
      setRenameValue(label);
      renameValueRef.current = label;
    },
    [tree, closeContextMenu]
  );

  const cancelRename = useCallback(() => setRenaming(null), []);

  const commitRename = useCallback(
    async (nodeType: "task" | "branch", id: string) => {
      // Guard: prevent double-call from onBlur after Enter
      if (isCommittingRef.current) return;
      isCommittingRef.current = true;

      const name = renameValueRef.current.trim();
      if (!name) {
        cancelRename();
        isCommittingRef.current = false;
        return;
      }
      try {
        if (nodeType === "task") {
          await conn.sendRequest({ type: "rename_task", taskId: id, name });
        } else {
          await conn.sendRequest({ type: "rename_branch", branchSessionId: id, name });
        }
      } catch (err) {
        console.error("[SidebarTree] Rename failed:", err);
      }
      cancelRename();
      isCommittingRef.current = false;
      onRefresh();
    },
    [conn, onRefresh, cancelRename]
  );

  const handleDelete = useCallback(
    async (nodeType: "task" | "branch", id: string) => {
      closeContextMenu();
      if (nodeType === "task") {
        await conn.sendRequest({ type: "delete_task", taskId: id });
      } else {
        await conn.sendRequest({ type: "delete_branch", branchSessionId: id });
      }
      onRefresh();
    },
    [conn, onRefresh, closeContextMenu]
  );

  const handleMerge = useCallback(
    (branchSessionId: string) => {
      closeContextMenu();
      if (!onMerge) return;
      const branchNode = findNode(tree, branchSessionId);
      const name = branchNode?.label || branchSessionId;
      onMerge({ sessionId: branchSessionId, name });
    },
    [closeContextMenu, onMerge, tree]
  );

  const handleDeleteTurn = useCallback(
    async (sessionId: string, messageIndex: number) => {
      closeContextMenu();
      await conn.sendRequest({ type: "delete_turn", sessionId, targetIndex: messageIndex });
      onRefresh();
    },
    [closeContextMenu, conn, onRefresh]
  );

  const handleCopyTurnMessage = useCallback(
    async (sessionId: string, messageIndex: number) => {
      closeContextMenu();
      try {
        const result = await conn.sendRequest<{ text: string }>({
          type: "get_turn_text",
          sessionId,
          messageIndex,
        });
        if (result.text) {
          await navigator.clipboard.writeText(result.text);
        }
      } catch (err) {
        console.error("[SidebarTree] Copy turn message failed:", err);
      }
    },
    [closeContextMenu, conn]
  );

  // ── Create Task ──

  const handleCreateTask = useCallback(async () => {
    const name = `Task ${tree.length + 1}`;
    await conn.sendRequest({ type: "create_task", taskName: name });
    onRefresh();
  }, [conn, tree.length, onRefresh]);

  // ── Drag & Drop (task reorder) ──

  const handleDragStart = useCallback(
    (e: React.DragEvent, taskId: string) => {
      setDraggedTaskId(taskId);
      e.dataTransfer.effectAllowed = "move";
    },
    []
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (draggedTaskId) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    },
    [draggedTaskId]
  );

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetTaskId: string) => {
      e.preventDefault();
      if (!draggedTaskId || draggedTaskId === targetTaskId) {
        setDraggedTaskId(null);
        return;
      }

      const currentOrder = tree.map((t) => t.id);
      const fromIdx = currentOrder.indexOf(draggedTaskId);
      const toIdx = currentOrder.indexOf(targetTaskId);
      if (fromIdx < 0 || toIdx < 0) {
        setDraggedTaskId(null);
        return;
      }

      currentOrder.splice(fromIdx, 1);
      currentOrder.splice(toIdx, 0, draggedTaskId);

      await conn.sendRequest({ type: "reorder_tasks", taskIds: currentOrder });
      setDraggedTaskId(null);
      onRefresh();
    },
    [draggedTaskId, tree, conn, onRefresh]
  );

  // ── Find task ID for a branch node ──

  function findTaskForBranch(sessionId: string): string | null {
    for (const task of tree) {
      if (task.children?.some((b) => b.id === sessionId)) {
        return task.id;
      }
    }
    return null;
  }

  // ── Render ──

  return (
    <div className="sidebar-tree" onClick={closeContextMenu}>
      {/* Title header */}
      <div className="sidebar-title">
        <span className="sidebar-title-text">Tasks</span>
        <div className="sidebar-title-actions">
          {onImportSession && (
            <button
              className="sidebar-title-btn"
              onClick={onImportSession}
              title="Import Session"
            >
              ↓
            </button>
          )}
          <button
            className="sidebar-title-btn"
            onClick={handleCreateTask}
            title="New Task"
          >
            +
          </button>
        </div>
      </div>

      {tree.map((task) => (
        <div
          key={task.id}
          className={`tree-task ${activeTaskId === task.id ? "active" : ""}`}
          draggable
          onDragStart={(e) => handleDragStart(e, task.id)}
          onDragOver={handleDragOver}
          onDrop={(e) => handleDrop(e, task.id)}
        >
          {/* Task row */}
          <div
            className="tree-row tree-task-row"
            onClick={() => {
              toggleTask(task.id);
              onSelectTask(task.id);
            }}
            onContextMenu={(e) => handleContextMenu(e, task)}
          >
            <span className={`tree-arrow ${expandedTasks.has(task.id) ? "expanded" : ""}`}>
              {task.children?.length ? "▶" : ""}
            </span>
            {renaming?.id === task.id && renaming.type === "task" ? (
              <input
                className="tree-rename-input"
                value={renameValue}
                onChange={(e) => { setRenameValue(e.target.value); renameValueRef.current = e.target.value; }}
                onBlur={() => commitRename("task", task.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitRename("task", task.id);
                  if (e.key === "Escape") cancelRename();
                }}
                autoFocus
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="tree-label">{task.label}</span>
            )}
          </div>

          {/* Branch children */}
          {expandedTasks.has(task.id) &&
            task.children?.map((branch) => (
              <div key={branch.id} className="tree-branch-group">
                <div
                  className={`tree-row tree-branch-row ${activeSessionId === branch.id ? "active" : ""}`}
                  onClick={() => {
                    toggleBranch(branch.id);
                    onSelectBranch(task.id, branch.sessionId!);
                  }}
                  onContextMenu={(e) => handleContextMenu(e, branch, task.id)}
                >
                  <span className={`tree-arrow ${expandedBranches.has(branch.id) ? "expanded" : ""}`}>
                    {branch.children?.length ? "▶" : ""}
                  </span>
                  {renaming?.id === branch.id && renaming.type === "branch" ? (
                    <input
                      className="tree-rename-input"
                      value={renameValue}
                      onChange={(e) => { setRenameValue(e.target.value); renameValueRef.current = e.target.value; }}
                      onBlur={() => commitRename("branch", branch.id)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename("branch", branch.id);
                        if (e.key === "Escape") cancelRename();
                      }}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                    />
                  ) : (
                    <span className="tree-label">{branch.label}</span>
                  )}
                  {branch.branchStatus && branch.branchStatus !== "active" && (
                    <span className={`tree-badge tree-badge-${branch.branchStatus}`}>
                      {branch.branchStatus}
                    </span>
                  )}
                </div>

                {/* Turn children */}
                {expandedBranches.has(branch.id) &&
                  branch.children?.map((turn) => (
                    <div
                      key={turn.id}
                      className="tree-row tree-turn-row"
                      onClick={() =>
                        onSelectTurn(task.id, turn.sessionId!, turn.messageIndex!, turn.displayMessageIndex ?? turn.messageIndex!)
                      }
                      onContextMenu={(e) => handleContextMenu(e, turn, task.id)}
                    >
                      <span className="tree-turn-label">{turn.label}</span>
                    </div>
                  ))}
              </div>
            ))}
        </div>
      ))}

      {/* Context Menu */}
      {contextMenu && (
        <div
          className="contextMenu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          {contextMenu.node.type === "task" && (
            <>
              <div
                className="contextMenuItem"
                onClick={() => handleRename("task", contextMenu.node.id)}
              >
                Rename Task
              </div>
              {/* Rename main branch: expand task, then activate rename on its first child */}
              {contextMenu.node.children?.[0] && (
                <div
                  className="contextMenuItem"
                  onClick={() => {
                    const mainBranch = contextMenu.node.children![0];
                    // Ensure task is expanded so the rename input is visible
                    setExpandedTasks((prev) => {
                      const next = new Set(prev);
                      next.add(contextMenu.node.id);
                      return next;
                    });
                    handleRename("branch", mainBranch.id);
                  }}
                >
                  Rename Main Branch
                </div>
              )}
              <div className="contextMenuDivider" />
              <div
                className="contextMenuItem danger"
                onClick={() => handleDelete("task", contextMenu.node.id)}
              >
                Delete
              </div>
            </>
          )}
          {contextMenu.node.type === "branch" && (
            <>
              <div
                className="contextMenuItem"
                onClick={() => handleRename("branch", contextMenu.node.id)}
              >
                Rename
              </div>
              <div
                className="contextMenuItem"
                onClick={() => handleMerge(contextMenu.node.id)}
              >
                Merge to Parent
              </div>
              <div className="contextMenuDivider" />
              <div
                className="contextMenuItem danger"
                onClick={() => handleDelete("branch", contextMenu.node.id)}
              >
                Delete
              </div>
            </>
          )}
          {contextMenu.node.type === "turn" && (
            <>
              <div
                className="contextMenuItem"
                onClick={() =>
                  handleCopyTurnMessage(
                    contextMenu.node.sessionId!,
                    contextMenu.node.messageIndex!
                  )
                }
              >
                Copy Message
              </div>
              {/* Merge up to here — only for non-main active branches */}
              {onMergeTurn && (() => {
                const parentBranch = findParentBranch(tree, contextMenu.node.sessionId!);
                if (parentBranch && parentBranch.branchStatus !== "deleted") {
                  return (
                    <>
                      <div className="contextMenuDivider" />
                      <div
                        className="contextMenuItem"
                        onClick={() => {
                          closeContextMenu();
                          onMergeTurn({
                            sessionId: contextMenu.node.sessionId!,
                            turnMsgIndex: contextMenu.node.messageIndex!,
                            branchName: parentBranch.label,
                          });
                        }}
                      >
                        Merge up to here
                      </div>
                    </>
                  );
                }
                return null;
              })()}
              <div className="contextMenuDivider" />
              <div
                className="contextMenuItem danger"
                onClick={() =>
                  handleDeleteTurn(
                    contextMenu.node.sessionId!,
                    contextMenu.node.messageIndex!
                  )
                }
              >
                Delete Turn
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── Utility ──

function findNode(tree: SidebarTreeNode[], id: string): SidebarTreeNode | null {
  for (const node of tree) {
    if (node.id === id) return node;
    if (node.children) {
      const found = findNode(node.children, id);
      if (found) return found;
    }
  }
  return null;
}

/** Find the branch node that contains a turn with the given sessionId */
function findParentBranch(tree: SidebarTreeNode[], sessionId: string): SidebarTreeNode | null {
  for (const task of tree) {
    if (task.children) {
      for (const branch of task.children) {
        if (branch.type === "branch" && branch.sessionId === sessionId) {
          return branch;
        }
      }
    }
  }
  return null;
}
