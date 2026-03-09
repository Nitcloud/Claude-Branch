/**
 * SessionList — displays all conversation records from the project folder.
 * Features: click to resume, right-click context menu (rename/delete),
 * drag-to-reorder with persistent ordering.
 */

import React, { useState, useEffect, useCallback, useRef } from "react";
import { getConnection } from "../connection/Connection";

export interface SessionInfo {
  sessionId: string;
  title: string;
  lastModified: string;
  messageCount: number;
  sizeBytes: number;
}

interface SessionListProps {
  onSelectSession: (sessionId: string) => void;
  onNewConversation: () => void;
  activeSessionId?: string;
}

export function SessionList({
  onSelectSession,
  onNewConversation,
  activeSessionId,
}: SessionListProps): React.ReactElement {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Context menu state
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    sessionId: string;
  } | null>(null);

  // Rename state
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Drag state
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const loadSessions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const connection = getConnection();
      const result = await connection.sendRequest<{
        sessions: SessionInfo[];
      }>({ type: "list_sessions_request" });
      setSessions(result.sessions || []);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const connection = getConnection();
    if (connection.ready) {
      loadSessions();
    } else {
      connection.onReady(loadSessions);
    }
  }, [loadSessions]);

  // Close context menu on click anywhere
  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    document.addEventListener("click", close);
    document.addEventListener("contextmenu", close);
    return () => {
      document.removeEventListener("click", close);
      document.removeEventListener("contextmenu", close);
    };
  }, [ctxMenu]);

  // Auto-focus rename input
  useEffect(() => {
    if (renamingId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renamingId]);

  // ---- Context menu actions ----

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, sessionId: string) => {
      e.preventDefault();
      e.stopPropagation();
      setCtxMenu({ x: e.clientX, y: e.clientY, sessionId });
    },
    []
  );

  const handleDelete = useCallback(async () => {
    if (!ctxMenu) return;
    const { sessionId } = ctxMenu;
    setCtxMenu(null);

    const session = sessions.find((s) => s.sessionId === sessionId);
    const label = session ? truncateTitle(session.title, 40) : sessionId.slice(0, 8);
    if (!window.confirm(`Delete "${label}"?\nThis will permanently remove the session file from disk.`)) {
      return;
    }

    const connection = getConnection();
    await connection.sendRequest({ type: "delete_session", sessionId });
    setSessions((prev) => prev.filter((s) => s.sessionId !== sessionId));
  }, [ctxMenu, sessions]);

  const handleStartRename = useCallback(() => {
    if (!ctxMenu) return;
    const session = sessions.find((s) => s.sessionId === ctxMenu.sessionId);
    setRenamingId(ctxMenu.sessionId);
    setRenameValue(session?.title || "");
    setCtxMenu(null);
  }, [ctxMenu, sessions]);

  const handleRenameSubmit = useCallback(async () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }

    const connection = getConnection();
    await connection.sendRequest({
      type: "rename_session",
      sessionId: renamingId,
      name: renameValue.trim(),
    });
    setSessions((prev) =>
      prev.map((s) =>
        s.sessionId === renamingId ? { ...s, title: renameValue.trim() } : s
      )
    );
    setRenamingId(null);
  }, [renamingId, renameValue]);

  const handleRenameKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleRenameSubmit();
      } else if (e.key === "Escape") {
        setRenamingId(null);
      }
    },
    [handleRenameSubmit]
  );

  // ---- Drag-to-reorder ----

  const handleDragStart = useCallback(
    (e: React.DragEvent, sessionId: string) => {
      setDragId(sessionId);
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", sessionId);
      // Make the drag image slightly transparent
      if (e.currentTarget instanceof HTMLElement) {
        e.currentTarget.style.opacity = "0.5";
      }
    },
    []
  );

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.style.opacity = "";
    }
    setDragId(null);
    setDragOverId(null);
  }, []);

  const handleDragOver = useCallback(
    (e: React.DragEvent, sessionId: string) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      if (sessionId !== dragId) {
        setDragOverId(sessionId);
      }
    },
    [dragId]
  );

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    async (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragOverId(null);

      if (!dragId || dragId === targetId) return;

      // Reorder locally
      const newSessions = [...sessions];
      const fromIdx = newSessions.findIndex((s) => s.sessionId === dragId);
      const toIdx = newSessions.findIndex((s) => s.sessionId === targetId);
      if (fromIdx < 0 || toIdx < 0) return;

      const [moved] = newSessions.splice(fromIdx, 1);
      newSessions.splice(toIdx, 0, moved);
      setSessions(newSessions);

      // Persist order
      const connection = getConnection();
      await connection.sendRequest({
        type: "reorder_sessions",
        sessionIds: newSessions.map((s) => s.sessionId),
      });
    },
    [dragId, sessions]
  );

  return (
    <div className="session-list">
      <div className="session-list-header">
        <h3 className="session-list-title">Conversations</h3>
        <div className="session-list-actions">
          <button
            className="session-btn session-btn-refresh"
            onClick={loadSessions}
            title="Refresh"
          >
            &#x21bb;
          </button>
          <button
            className="session-btn session-btn-new"
            onClick={onNewConversation}
            title="New conversation"
          >
            +
          </button>
        </div>
      </div>

      <div className="session-list-content">
        {loading && (
          <div className="session-list-empty">Loading sessions...</div>
        )}
        {error && (
          <div className="session-list-error">
            Failed to load sessions: {error}
          </div>
        )}
        {!loading && !error && sessions.length === 0 && (
          <div className="session-list-empty">No previous conversations</div>
        )}
        {!loading &&
          sessions.map((session) => (
            <SessionItem
              key={session.sessionId}
              session={session}
              isActive={session.sessionId === activeSessionId}
              isRenaming={session.sessionId === renamingId}
              renameValue={renameValue}
              onRenameChange={setRenameValue}
              onRenameSubmit={handleRenameSubmit}
              onRenameKeyDown={handleRenameKeyDown}
              renameInputRef={
                session.sessionId === renamingId ? renameInputRef : undefined
              }
              isDragOver={session.sessionId === dragOverId}
              onClick={() => {
                if (renamingId) return;
                onSelectSession(session.sessionId);
              }}
              onContextMenu={(e) => handleContextMenu(e, session.sessionId)}
              onDragStart={(e) => handleDragStart(e, session.sessionId)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, session.sessionId)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, session.sessionId)}
            />
          ))}
      </div>

      {/* Context menu */}
      {ctxMenu && (
        <div
          className="session-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
        >
          <button className="session-ctx-item" onClick={handleStartRename}>
            Rename
          </button>
          <button
            className="session-ctx-item session-ctx-item-danger"
            onClick={handleDelete}
          >
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

// ============================================================
// SessionItem sub-component
// ============================================================

interface SessionItemProps {
  session: SessionInfo;
  isActive: boolean;
  isRenaming: boolean;
  renameValue: string;
  onRenameChange: (v: string) => void;
  onRenameSubmit: () => void;
  onRenameKeyDown: (e: React.KeyboardEvent) => void;
  renameInputRef?: React.Ref<HTMLInputElement>;
  isDragOver: boolean;
  onClick: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onDragStart: (e: React.DragEvent) => void;
  onDragEnd: (e: React.DragEvent) => void;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: () => void;
  onDrop: (e: React.DragEvent) => void;
}

function SessionItem({
  session,
  isActive,
  isRenaming,
  renameValue,
  onRenameChange,
  onRenameSubmit,
  onRenameKeyDown,
  renameInputRef,
  isDragOver,
  onClick,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
}: SessionItemProps): React.ReactElement {
  const date = new Date(session.lastModified);
  const timeStr = formatRelativeTime(date);
  const sizeStr = formatSize(session.sizeBytes);

  const className = [
    "session-item",
    isActive ? "session-item-active" : "",
    isDragOver ? "session-item-dragover" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      className={className}
      onClick={onClick}
      onContextMenu={onContextMenu}
      draggable={!isRenaming}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {isRenaming ? (
        <input
          ref={renameInputRef}
          className="session-rename-input"
          value={renameValue}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameSubmit}
          onKeyDown={onRenameKeyDown}
        />
      ) : (
        <div className="session-item-title">
          {truncateTitle(session.title, 80)}
        </div>
      )}
      <div className="session-item-meta">
        <span>{timeStr}</span>
        <span>{session.messageCount} msgs</span>
        <span>{sizeStr}</span>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

function truncateTitle(title: string, max = 80): string {
  if (title.length <= max) return title;
  return title.slice(0, max - 3) + "...";
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString();
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
