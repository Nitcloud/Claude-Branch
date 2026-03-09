/**
 * GraphControls — Controls Bar with 3 custom dropdowns + refresh button.
 * Styled to match vscode-git-graph controls bar.
 *
 * 1. Task (single select) — which task's graph to display
 * 2. Branches (multi select) — which branches to render in SVG
 * 3. View (single select) — which branch's conversation to show below
 */

import React, { useCallback } from "react";
import type { GraphBranch } from "../../src/types/branch-graph";
import { Dropdown, type DropdownOption } from "./Dropdown";

export interface GraphControlsProps {
  tasks: Array<{ taskId: string; taskName: string }>;
  activeTaskId: string | null;
  branches: GraphBranch[];
  visibleBranchIds: string[] | null;
  viewBranchId: string | null;
  onSelectTask: (taskId: string) => void;
  onToggleBranchVisibility: (sessionIds: string[] | null) => void;
  onSelectViewBranch: (sessionId: string) => void;
  onRefresh: () => void;
}

export function GraphControls({
  tasks,
  activeTaskId,
  branches,
  visibleBranchIds,
  viewBranchId,
  onSelectTask,
  onToggleBranchVisibility,
  onSelectViewBranch,
  onRefresh,
}: GraphControlsProps): React.ReactElement {
  // ── Task dropdown ──
  const taskOptions: DropdownOption[] = tasks.map((t) => ({
    value: t.taskId,
    label: t.taskName,
  }));

  const handleTaskChange = useCallback(
    (values: string[]) => {
      if (values.length > 0) onSelectTask(values[0]);
    },
    [onSelectTask]
  );

  // ── Graph Branches multi-select ──
  const branchOptions: DropdownOption[] = branches.map((b) => ({
    value: b.sessionId,
    label: b.name,
    hint: b.status !== "active" ? `(${b.status})` : undefined,
  }));

  // All branch session IDs for "all selected" state
  const allBranchIds = branches.map((b) => b.sessionId);

  const handleBranchVisibility = useCallback(
    (values: string[]) => {
      if (values.length === 0 || values.length === allBranchIds.length) {
        onToggleBranchVisibility(null);
      } else {
        onToggleBranchVisibility(values);
      }
    },
    [onToggleBranchVisibility, allBranchIds.length]
  );

  // ── View Branch dropdown ──
  const viewOptions: DropdownOption[] = branches.map((b) => ({
    value: b.sessionId,
    label: b.name,
  }));

  const handleViewBranch = useCallback(
    (values: string[]) => {
      if (values.length > 0) onSelectViewBranch(values[0]);
    },
    [onSelectViewBranch]
  );

  return (
    <div className="graph-controls">
      {/* Task selector */}
      <span className="graph-control-group">
        <span className="graph-control-label">Task:</span>
        <Dropdown
          options={taskOptions}
          value={activeTaskId || ""}
          onChange={handleTaskChange}
          placeholder="Select task"
        />
      </span>

      {/* Graph Branches (multi-select for visibility) */}
      <span className="graph-control-group">
        <span className="graph-control-label">Branches:</span>
        <Dropdown
          options={branchOptions}
          value={visibleBranchIds || allBranchIds}
          multi
          onChange={handleBranchVisibility}
          placeholder="All"
        />
      </span>

      {/* View Branch (which session to display in lower panel) */}
      <span className="graph-control-group">
        <span className="graph-control-label">View:</span>
        <Dropdown
          options={viewOptions}
          value={viewBranchId || ""}
          onChange={handleViewBranch}
          placeholder="Select branch"
        />
      </span>

      {/* Refresh */}
      <button className="graph-control-refresh" onClick={onRefresh} title="Refresh">
        &#x21bb;
      </button>
    </div>
  );
}
