/**
 * ErrorBoundary — catches React rendering errors and displays them
 * instead of letting the entire React tree silently unmount.
 *
 * In React 18, an uncaught rendering error unmounts the whole tree,
 * leaving the DOM visible but with all event handlers detached.
 * This component prevents that by catching errors at the boundary.
 */

import React from "react";

interface ErrorBoundaryProps {
  children: React.ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    console.error("[ErrorBoundary] Caught rendering error:", error, errorInfo);
    this.setState({ errorInfo });
  }

  render(): React.ReactNode {
    if (this.state.hasError) {
      return (
        <div
          style={{
            padding: 20,
            color: "#f44336",
            background: "#1e1e1e",
            height: "100%",
            overflow: "auto",
            fontFamily: "monospace",
            fontSize: 13,
          }}
        >
          <h2 style={{ color: "#ff6b6b", margin: "0 0 12px" }}>
            Rendering Error
          </h2>
          <pre style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>
            {this.state.error?.toString()}
          </pre>
          {this.state.errorInfo && (
            <details style={{ marginTop: 12 }}>
              <summary style={{ cursor: "pointer", color: "#aaa" }}>
                Component Stack
              </summary>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-all",
                  color: "#888",
                  marginTop: 8,
                }}
              >
                {this.state.errorInfo.componentStack}
              </pre>
            </details>
          )}
          <button
            onClick={() =>
              this.setState({ hasError: false, error: null, errorInfo: null })
            }
            style={{
              marginTop: 16,
              padding: "8px 16px",
              background: "#0e639c",
              color: "#fff",
              border: "none",
              borderRadius: 4,
              cursor: "pointer",
              fontSize: 13,
            }}
          >
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
