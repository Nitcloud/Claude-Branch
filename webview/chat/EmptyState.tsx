/**
 * EmptyState — shown when no messages exist yet.
 * Matches original Claude Code extension: fadeIn animation, monospace font, centered.
 */

import React from "react";

export function EmptyState(): React.ReactElement {
  return (
    <div className="empty-state">
      <div className="empty-state-content">
        <div className="empty-state-icon">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
        </div>
        <h2>Claude Code</h2>
        <p>Ask Claude anything about your code. Claude can read files, make edits, run commands, and more.</p>
        <div className="empty-state-tips">
          <div className="tip">
            <strong>@</strong> Reference files for context
          </div>
          <div className="tip">
            <strong>/</strong> Use slash commands
          </div>
          <div className="tip">
            <strong>Shift+Tab</strong> Change permission mode
          </div>
        </div>
      </div>
    </div>
  );
}
