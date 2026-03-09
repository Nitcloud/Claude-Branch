/**
 * App — root React component.
 * Single-page layout: BranchGraphView is the main (and only) view.
 * It integrates sidebar navigation, graph visualization, and ChatView.
 */

import React from "react";
import { ErrorBoundary } from "./ErrorBoundary";
import { BranchGraphView } from "./graph/BranchGraphView";
import "./graph/graph.css";

export function App(): React.ReactElement {
  return (
    <ErrorBoundary>
      <BranchGraphView />
    </ErrorBoundary>
  );
}
