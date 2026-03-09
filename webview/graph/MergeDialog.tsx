/**
 * MergeDialog — Incremental merge with turn selection and AI summary.
 */

import React, { useState, useEffect, useCallback } from "react";
import { getConnection } from "../connection/Connection";
import type {
  MergePreviewResponse,
  GenerateMergeSummaryResponse,
} from "../../src/types/webview-protocol";
import type { MergeRecord } from "../../src/types/branch-graph";

export interface MergeDialogProps {
  branchSessionId: string;
  branchName: string;
  /** Pre-selected merge-to turn index (from right-click turn) */
  preselectedTurnIndex?: number;
  onClose: () => void;
  onMerged: () => void;
}

export function MergeDialog({
  branchSessionId,
  branchName,
  preselectedTurnIndex,
  onClose,
  onMerged,
}: MergeDialogProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [availableFrom, setAvailableFrom] = useState(0);
  const [totalMsgCount, setTotalMsgCount] = useState(0);
  const [mergeHistory, setMergeHistory] = useState<MergeRecord[]>([]);
  const [selectedTo, setSelectedTo] = useState(0);
  const [summary, setSummary] = useState("");
  const [generating, setGenerating] = useState(false);
  const [merging, setMerging] = useState(false);
  const [error, setError] = useState("");

  const conn = getConnection();

  // Load merge preview on mount
  useEffect(() => {
    (async () => {
      try {
        const result = await conn.sendRequest<MergePreviewResponse>({
          type: "get_merge_preview",
          branchSessionId,
        });
        setAvailableFrom(result.availableFromIndex);
        setTotalMsgCount(result.totalMsgCount);
        setMergeHistory(result.mergeHistory);

        // Set initial selectedTo
        if (preselectedTurnIndex !== undefined && preselectedTurnIndex >= result.availableFromIndex) {
          setSelectedTo(preselectedTurnIndex);
        } else {
          // Default to last available turn
          setSelectedTo(result.totalMsgCount - 1);
        }
      } catch (err) {
        setError(`Failed to load preview: ${err}`);
      } finally {
        setLoading(false);
      }
    })();
  }, [branchSessionId, conn, preselectedTurnIndex]);

  // Generate AI summary
  const handleGenerate = useCallback(async () => {
    setGenerating(true);
    setError("");
    try {
      const result = await conn.sendRequest<GenerateMergeSummaryResponse>({
        type: "generate_merge_summary",
        branchSessionId,
        fromMsgIndex: availableFrom,
        toMsgIndex: selectedTo,
      });
      setSummary(result.summary);
    } catch (err) {
      setError(`AI summary generation failed: ${err}`);
    } finally {
      setGenerating(false);
    }
  }, [conn, branchSessionId, availableFrom, selectedTo]);

  // Perform merge
  const handleMerge = useCallback(async () => {
    setMerging(true);
    try {
      await conn.sendRequest({
        type: "merge_branch",
        branchSessionId,
        mergeSummary: summary,
        fromMsgIndex: availableFrom,
        toMsgIndex: selectedTo,
      });
      onMerged();
    } catch (err) {
      console.error("Merge failed:", err);
      setError(`Merge failed: ${err}`);
      setMerging(false);
    }
  }, [conn, branchSessionId, summary, availableFrom, selectedTo, onMerged]);

  const hasAvailableTurns = totalMsgCount > availableFrom;
  const turnOptions: number[] = [];
  for (let i = availableFrom; i < totalMsgCount; i++) {
    turnOptions.push(i);
  }

  return (
    <div className="merge-dialog-overlay" onClick={onClose}>
      <div className="merge-dialog" onClick={(e) => e.stopPropagation()}>
        <div className="merge-dialog-header">
          <h3>Merge Branch: {branchName}</h3>
          <button className="merge-dialog-close" onClick={onClose}>
            &times;
          </button>
        </div>

        {loading ? (
          <div className="merge-dialog-loading">Loading...</div>
        ) : !hasAvailableTurns ? (
          <div className="merge-dialog-info">
            All turns have been merged. No remaining turns to merge.
          </div>
        ) : (
          <>
            {/* Merge history */}
            {mergeHistory.length > 0 && (
              <div className="merge-dialog-history">
                <label>Merge History:</label>
                {mergeHistory.map((mr, i) => (
                  <div key={i} className="merge-dialog-history-item">
                    Turns #{mr.fromMsgIndex + 1} ~ #{mr.toMsgIndex + 1}
                    <span className="merge-dialog-history-date">
                      {new Date(mr.timestamp).toLocaleDateString()}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Range selector */}
            <div className="merge-dialog-range">
              <label>Merge Range:</label>
              <div className="merge-dialog-range-row">
                <span>From: Turn #{availableFrom + 1}</span>
                <span>
                  To:&nbsp;
                  <select
                    value={selectedTo}
                    onChange={(e) => setSelectedTo(Number(e.target.value))}
                  >
                    {turnOptions.map((i) => (
                      <option key={i} value={i}>
                        Turn #{i + 1}{i === totalMsgCount - 1 ? " (last)" : ""}
                      </option>
                    ))}
                  </select>
                </span>
              </div>
            </div>

            {/* AI generate button */}
            <div className="merge-dialog-section">
              <button
                className="merge-dialog-btn merge-dialog-btn-generate"
                onClick={handleGenerate}
                disabled={generating}
              >
                {generating ? "Generating AI Summary..." : "Generate AI Summary"}
              </button>
            </div>

            {/* Summary editor */}
            <div className="merge-dialog-section">
              <label>Merge Summary (will be injected into parent):</label>
              <textarea
                className="merge-dialog-textarea"
                value={summary}
                onChange={(e) => setSummary(e.target.value)}
                rows={10}
                placeholder="Click 'Generate AI Summary' or write your own summary..."
              />
            </div>

            {error && <div className="merge-dialog-error">{error}</div>}

            <div className="merge-dialog-actions">
              <button
                className="merge-dialog-btn merge-dialog-btn-cancel"
                onClick={onClose}
              >
                Cancel
              </button>
              <button
                className="merge-dialog-btn merge-dialog-btn-merge"
                onClick={handleMerge}
                disabled={merging || !summary.trim()}
              >
                {merging ? "Merging..." : "Merge"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
