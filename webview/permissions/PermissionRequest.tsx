/**
 * PermissionRequest — tool permission approval UI.
 */

import React, { useCallback, useEffect, useRef } from "react";

interface Props {
  toolName: string;
  toolInput: Record<string, unknown>;
  suggestions: Array<{ label: string; value: string; description?: string }>;
  description?: string;
  onAccept: (updatedInput?: Record<string, unknown>) => void;
  onReject: (reason?: string) => void;
}

export function PermissionRequest({
  toolName,
  toolInput,
  suggestions,
  description,
  onAccept,
  onReject,
}: Props): React.ReactElement {
  const containerRef = useRef<HTMLDivElement>(null);

  // Keyboard shortcuts
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "y" || e.key === "Enter") {
        e.preventDefault();
        onAccept();
      } else if (e.key === "n" || e.key === "Escape") {
        e.preventDefault();
        onReject();
      } else if (e.key >= "1" && e.key <= "9") {
        const idx = parseInt(e.key) - 1;
        if (idx < suggestions.length) {
          e.preventDefault();
          onAccept(); // TODO: apply suggestion
        }
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onAccept, onReject, suggestions]);

  // Focus container
  useEffect(() => {
    containerRef.current?.focus();
  }, []);

  return (
    <div className="permission-request" ref={containerRef} tabIndex={-1}>
      <div className="permission-header">
        <span className="permission-icon">🛡️</span>
        <span className="permission-title">
          Allow <strong>{toolName}</strong>?
        </span>
      </div>

      {description && (
        <div className="permission-description">{description}</div>
      )}

      <div className="permission-preview">
        {toolName === "Bash" || toolName === "BashTool" ? (
          <pre className="permission-command">
            {String(toolInput.command ?? "")}
          </pre>
        ) : (
          <pre className="permission-input">
            {JSON.stringify(toolInput, null, 2)}
          </pre>
        )}
      </div>

      {suggestions.length > 0 && (
        <div className="permission-suggestions">
          {suggestions.map((s, i) => (
            <button
              key={i}
              className="suggestion-button"
              onClick={() => onAccept()}
              title={s.description}
            >
              <span className="suggestion-key">{i + 1}</span>
              {s.label}
            </button>
          ))}
        </div>
      )}

      <div className="permission-actions">
        <button className="btn btn-primary" onClick={() => onAccept()}>
          Allow (y)
        </button>
        <button className="btn btn-secondary" onClick={() => onReject()}>
          Deny (n)
        </button>
      </div>
    </div>
  );
}
