/**
 * GraphTable — SVG graph + commit table.
 * Layout: SVG absolutely positioned over a real <table>,
 * matching the vscode-git-graph overlay pattern.
 */

import React, { useMemo, useCallback, useRef, useEffect, useState } from "react";
import type { GraphNode, BranchGraphData } from "../../src/types/branch-graph";
import { ConversationGraph, DEFAULT_CONFIG } from "./ConversationGraph";
import { getConnection } from "../connection/Connection";

export interface GraphTableProps {
  graphData: BranchGraphData;
  visibleBranchIds: string[] | null;
  onNodeClick: (node: GraphNode) => void;
  onBranchFromHere: (node: GraphNode) => void;
  onRewindToHere: (node: GraphNode) => void;
  onForkAndRewind: (node: GraphNode) => void;
  onDeleteTurn?: (node: GraphNode) => void;
  highlightedNodeIndex?: number;
}

export function GraphTable({
  graphData,
  visibleBranchIds,
  onNodeClick,
  onBranchFromHere,
  onRewindToHere,
  onForkAndRewind,
  onDeleteTurn,
  highlightedNodeIndex,
}: GraphTableProps): React.ReactElement {
  const contentRef = useRef<HTMLDivElement>(null);
  const conn = getConnection();

  // Build and render graph — wrapped in try/catch to prevent silent crashes
  const { renderResult, filteredNodes, renderError } = useMemo(() => {
    try {
      const graph = new ConversationGraph();
      if (visibleBranchIds) {
        graph.setVisibleBranches(visibleBranchIds);
      }
      const nodes = graphData.nodes ?? [];
      graph.loadNodes({ ...graphData, nodes });
      const renderResult = graph.render();

      let filteredNodes = nodes;
      if (visibleBranchIds) {
        const set = new Set(visibleBranchIds);
        filteredNodes = nodes.filter((n) => set.has(n.sessionId));
      }
      // Sort descending to match ConversationGraph vertex ordering (newest first)
      filteredNodes = [...filteredNodes].sort((a, b) => b.id - a.id);

      return { renderResult, filteredNodes, renderError: null as string | null };
    } catch (err) {
      console.error("[GraphTable] Graph render error:", err);
      return {
        renderResult: { svgContent: "", width: 80, height: 30, vertexColours: [] as number[], widthsAtVertices: [] as number[] },
        filteredNodes: [] as GraphNode[],
        renderError: String(err),
      };
    }
  }, [graphData, visibleBranchIds]);

  // Scroll to highlighted node
  useEffect(() => {
    if (highlightedNodeIndex !== undefined && contentRef.current) {
      const row = contentRef.current.querySelector(
        `tr[data-id="${highlightedNodeIndex}"]`
      );
      if (row) {
        row.scrollIntoView({ behavior: "smooth", block: "center" });
      }
    }
  }, [highlightedNodeIndex]);

  // Handle SVG circle clicks
  const handleSvgClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const target = e.target as SVGElement;
      const nodeId = target.getAttribute("data-id");
      if (nodeId !== null) {
        const idx = parseInt(nodeId, 10);
        const node = filteredNodes[idx];
        if (node) onNodeClick(node);
      }
    },
    [filteredNodes, onNodeClick]
  );

  // Context menu
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    node: GraphNode;
  } | null>(null);

  const handleRowContextMenu = useCallback(
    (e: React.MouseEvent, node: GraphNode) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, node });
    },
    []
  );

  const closeContextMenu = useCallback(() => setContextMenu(null), []);

  const handleCopyMessage = useCallback(
    async (node: GraphNode) => {
      closeContextMenu();
      try {
        const result = await conn.sendRequest<{ text: string }>({
          type: "get_turn_text",
          sessionId: node.sessionId,
          messageIndex: node.messageIndex,
        });
        if (result.text) {
          await navigator.clipboard.writeText(result.text);
        }
      } catch (err) {
        console.error("[GraphTable] Copy message failed:", err);
      }
    },
    [closeContextMenu, conn]
  );

  // Format time
  const formatTime = (iso: string): string => {
    try {
      const d = new Date(iso);
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    } catch {
      return "";
    }
  };

  // Branch color from vertex colour index
  const getBranchColor = (nodeIndex: number): string => {
    if (nodeIndex < renderResult.vertexColours.length) {
      return DEFAULT_CONFIG.colours[renderResult.vertexColours[nodeIndex]];
    }
    return DEFAULT_CONFIG.colours[0];
  };

  // Graph column width = SVG width
  const graphColWidth = renderResult.width;

  // Row height must match ConversationGraph grid.y for SVG alignment
  const rowHeight = DEFAULT_CONFIG.grid.y;

  // Table header height (18px line-height + 12px padding = 30px)
  const headerHeight = 30;

  if (renderError) {
    return (
      <div className="graph-content" style={{ padding: 16, color: "#f44336" }}>
        <div>Graph render error: {renderError}</div>
      </div>
    );
  }

  return (
    <div className="graph-content" ref={contentRef} onClick={closeContextMenu}>
      {/* SVG overlay — absolutely positioned over the table */}
      <div
        className="graph-svg-overlay"
        style={{ width: graphColWidth, height: renderResult.height + headerHeight }}
        onClick={handleSvgClick}
        dangerouslySetInnerHTML={{
          __html: `<svg width="${graphColWidth}" height="${renderResult.height + headerHeight}" style="display:block">${renderResult.svgContent}</svg>`,
        }}
      />

      {/* Commit table */}
      <div className="graph-table-wrapper">
        <table>
          <thead>
            <tr>
              <th style={{ width: graphColWidth, minWidth: graphColWidth }}>Graph</th>
              <th>Description</th>
              <th className="dateCol">Date</th>
              <th className="msgCol">Msg</th>
            </tr>
          </thead>
          <tbody>
            {filteredNodes.map((node, i) => (
              <tr
                key={node.id}
                className={`commit${highlightedNodeIndex === i ? " highlighted" : ""}${node.isCurrent ? " current" : ""}`}
                data-id={i}
                style={{ height: rowHeight }}
                onClick={() => onNodeClick(node)}
                onContextMenu={(e) => handleRowContextMenu(e, node)}
              >
                {/* Graph column — empty, SVG overlays it */}
                <td style={{ width: graphColWidth, minWidth: graphColWidth }}></td>

                {/* Description */}
                <td>
                  <span className="description">
                    {/* Branch ref labels */}
                    {node.isForkPoint && (
                      <span className="gitRef fork">
                        <span className="gitRefName">fork</span>
                      </span>
                    )}
                    {node.isMergePoint && (
                      <span className="gitRef merge">
                        <span className="gitRefName">merge</span>
                      </span>
                    )}
                    {/* Show branch name on first (newest) node of each branch */}
                    {node.isCurrent && node.branchName && (
                      <span
                        className="gitRef active"
                        style={{ borderColor: getBranchColor(i) }}
                      >
                        <span className="gitRefName">{node.branchName}</span>
                      </span>
                    )}
                    <span className="text">{node.messagePreview}</span>
                  </span>
                </td>

                {/* Date */}
                <td className="dateCol">{formatTime(node.timestamp)}</td>

                {/* Message number */}
                <td className="msgCol">#{node.messageIndex + 1}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Context menu */}
      {contextMenu && (
        <div
          className="contextMenu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <div
            className="contextMenuItem"
            onClick={() => handleCopyMessage(contextMenu.node)}
          >
            Copy message
          </div>
          <div className="contextMenuDivider" />
          <div
            className="contextMenuItem"
            onClick={() => {
              onBranchFromHere(contextMenu.node);
              closeContextMenu();
            }}
          >
            Fork conversation from here
          </div>
          <div
            className="contextMenuItem"
            onClick={() => {
              onRewindToHere(contextMenu.node);
              closeContextMenu();
            }}
          >
            Rewind code to here
          </div>
          <div
            className="contextMenuItem"
            onClick={() => {
              onForkAndRewind(contextMenu.node);
              closeContextMenu();
            }}
          >
            Fork conversation and rewind code
          </div>
          {onDeleteTurn && (
            <>
              <div className="contextMenuDivider" />
              <div
                className="contextMenuItem danger"
                onClick={() => {
                  onDeleteTurn(contextMenu.node);
                  closeContextMenu();
                }}
              >
                Delete this turn
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
