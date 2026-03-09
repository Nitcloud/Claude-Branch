/**
 * ★ CompactBoundary — renders a visual separator at compaction boundaries.
 * FIX: Shows as a divider line, NOT a wall that hides old messages.
 * Pre-compaction messages remain visible above this boundary (dimmed).
 */

import React from "react";
import type { MessageModel } from "../messages/MessageModel";
import { formatTokenCount } from "../messages/compaction";

interface Props {
  message: MessageModel;
}

export function CompactBoundary({ message }: Props): React.ReactElement {
  const metadata = message.compactMetadata;
  const summary = message.compactSummary;
  const triggerLabel = metadata?.trigger === "auto" ? "(auto)" : "(manual)";
  const tokenLabel = metadata?.pre_tokens
    ? `${formatTokenCount(metadata.pre_tokens)} tokens summarized`
    : "";

  return (
    <div className="compact-boundary">
      <div className="line" />
      <details>
        <summary>
          Context compacted {triggerLabel}
          {tokenLabel && ` — ${tokenLabel}`}
        </summary>
        {summary && <div className="summary-content">{summary}</div>}
        {!summary && metadata?.pre_tokens && (
          <div className="summary-content">
            The messages above this point were summarized by the model to fit
            within the context window. They remain visible for your reference.
          </div>
        )}
      </details>
      <div className="line" />
    </div>
  );
}
