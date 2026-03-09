/**
 * InputBox — matches original Claude Code extension input area.
 * Structure: input field on top, footer bar below with:
 *   1. Permission mode button (>> mode) — cycles on click
 *   2. Attached file indicator — shows attached context files
 *   3. Token/context usage — "X% context remaining"
 *   4. Spacer
 *   5. @ attach button — opens file input
 *   6. / command palette button — opens full command palette
 *   7. Send / interrupt button
 */

import React, { useRef, useCallback, useEffect, useState } from "react";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { PermissionModeMenu } from "./PermissionModeMenu";
import { ModelMenu } from "./ModelMenu";

interface Props {
  onSend: (text: string) => void;
  onInterrupt: () => void;
  isStreaming: boolean;
  disabled: boolean;
  permissionMode: string;
  model?: string;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  thinkingEnabled?: boolean;
  effortLevel?: string;
  onPermissionModeChange?: (mode: string) => void;
  onModelChange?: (model: string) => void;
  onSlashCommand?: (command: string) => void;
  onToggleThinking?: (enabled: boolean) => void;
  onEffortChange?: (level: string) => void;
}

const PERMISSION_MODES = ["default", "acceptEdits", "plan", "bypassPermissions"] as const;

export function InputBox({
  onSend,
  onInterrupt,
  isStreaming,
  disabled,
  permissionMode,
  model,
  totalInputTokens = 0,
  totalOutputTokens = 0,
  thinkingEnabled = true,
  effortLevel = "high",
  onPermissionModeChange,
  onModelChange,
  onSlashCommand,
  onToggleThinking,
  onEffortChange,
}: Props): React.ReactElement {
  const inputRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isEmpty, setIsEmpty] = useState(true);
  const [cmdPaletteOpen, setCmdPaletteOpen] = useState(false);
  const [cmdPaletteFilter, setCmdPaletteFilter] = useState<string | undefined>(undefined);
  const [permMenuOpen, setPermMenuOpen] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [attachedFiles, setAttachedFiles] = useState<AttachedFile[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Close menus on Escape
      if (e.key === "Escape") {
        if (cmdPaletteOpen) {
          setCmdPaletteOpen(false);
          setCmdPaletteFilter(undefined);
          e.preventDefault();
          return;
        }
        if (isStreaming) {
          onInterrupt();
          return;
        }
      }

      // Enter to send (unless shift held for newline)
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        if (cmdPaletteOpen) return; // Let palette handle it

        if (isStreaming) {
          onInterrupt();
          return;
        }
        const text = inputRef.current?.textContent?.trim() ?? "";
        if (text) {
          onSend(text);
          if (inputRef.current) {
            inputRef.current.textContent = "";
            setIsEmpty(true);
          }
        }
      }

      // Shift+Tab to cycle permission mode
      if (e.key === "Tab" && e.shiftKey) {
        e.preventDefault();
        cyclePermissionMode();
      }
    },
    [onSend, onInterrupt, isStreaming, cmdPaletteOpen, permissionMode]
  );

  const handleInput = useCallback(() => {
    const text = inputRef.current?.textContent ?? "";
    setIsEmpty(text.trim().length === 0);

    // Detect slash command typing: if text starts with "/" open the palette
    if (text.startsWith("/") && !text.includes(" ")) {
      setCmdPaletteOpen(true);
      setCmdPaletteFilter(text.slice(1)); // Remove the leading "/"
    } else if (cmdPaletteOpen && cmdPaletteFilter !== undefined) {
      // User was typing a slash command but now typed a space or cleared "/"
      setCmdPaletteOpen(false);
      setCmdPaletteFilter(undefined);
    }
  }, [cmdPaletteOpen, cmdPaletteFilter]);

  const doSend = useCallback(() => {
    if (isStreaming) {
      onInterrupt();
    } else {
      const text = inputRef.current?.textContent?.trim() ?? "";
      if (text) {
        onSend(text);
        if (inputRef.current) {
          inputRef.current.textContent = "";
          setIsEmpty(true);
        }
      }
    }
  }, [onSend, onInterrupt, isStreaming]);

  // Handle command palette action
  const handleCmdAction = useCallback(
    (actionId: string) => {
      // Close palette for most actions
      const closeAndRun = (fn: () => void) => {
        setCmdPaletteOpen(false);
        setCmdPaletteFilter(undefined);
        // Clear the input if user typed "/"
        if (inputRef.current) {
          const text = inputRef.current.textContent ?? "";
          if (text.startsWith("/")) {
            inputRef.current.textContent = "";
            setIsEmpty(true);
          }
        }
        fn();
      };

      switch (actionId) {
        case "attach-file":
          closeAndRun(() => fileInputRef.current?.click());
          break;
        case "mention-file":
          closeAndRun(() => {
            if (inputRef.current) {
              inputRef.current.textContent = "@";
              setIsEmpty(false);
              inputRef.current.focus();
            }
          });
          break;
        case "switch-model":
          closeAndRun(() => {
            setModelMenuOpen(true);
          });
          break;
        case "account-usage":
        case "fast-mode":
        case "add-slash-cmd":
        case "manage-mcp":
          closeAndRun(() => {});
          break;
        default: {
          // Check if it's a slash command (cmd-* or has slashCommand)
          if (actionId.startsWith("cmd-")) {
            const cmdName = actionId.slice(4);
            closeAndRun(() => {
              const commandText = `/${cmdName}`;
              if (onSlashCommand) {
                onSlashCommand(commandText);
              } else {
                onSend(commandText);
              }
            });
          } else if (actionId === "clear") {
            closeAndRun(() => {
              if (onSlashCommand) {
                onSlashCommand("/clear");
              } else {
                onSend("/clear");
              }
            });
          } else if (actionId === "add-claude-md") {
            closeAndRun(() => {
              if (onSlashCommand) {
                onSlashCommand("/memory");
              } else {
                onSend("/memory");
              }
            });
          } else {
            closeAndRun(() => {});
          }
          break;
        }
      }
    },
    [onSend, onSlashCommand, onEffortChange, effortLevel]
  );

  // Handle thinking toggle from command palette
  const handleToggleThinking = useCallback(
    (enabled: boolean) => {
      onToggleThinking?.(enabled);
    },
    [onToggleThinking]
  );

  // Handle effort cycle from command palette (low → medium → high → max → low)
  const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
  const handleEffortCycle = useCallback(() => {
    const idx = EFFORT_LEVELS.indexOf(effortLevel as typeof EFFORT_LEVELS[number]);
    const next = EFFORT_LEVELS[((idx === -1 ? -1 : idx) + 1) % EFFORT_LEVELS.length];
    onEffortChange?.(next);
  }, [effortLevel, onEffortChange]);

  // Open command palette via button click
  const handleSlashButtonClick = useCallback(() => {
    if (cmdPaletteOpen) {
      setCmdPaletteOpen(false);
      setCmdPaletteFilter(undefined);
    } else {
      setCmdPaletteOpen(true);
      setCmdPaletteFilter(undefined);
      setPermMenuOpen(false);
      setModelMenuOpen(false);
    }
  }, [cmdPaletteOpen]);

  // Cycle permission mode
  const cyclePermissionMode = useCallback(() => {
    const currentIdx = PERMISSION_MODES.indexOf(
      permissionMode as typeof PERMISSION_MODES[number]
    );
    const nextIdx = (currentIdx + 1) % PERMISSION_MODES.length;
    const nextMode = PERMISSION_MODES[nextIdx];
    onPermissionModeChange?.(nextMode);
  }, [permissionMode, onPermissionModeChange]);

  // Handle permission mode button click — toggle menu
  const handlePermButtonClick = useCallback(() => {
    setPermMenuOpen((prev) => !prev);
    setModelMenuOpen(false);
    setCmdPaletteOpen(false);
  }, []);

  // Handle file attach
  const handleAttachClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = e.target.files;
      if (!files) return;
      const newFiles: AttachedFile[] = [];
      for (let i = 0; i < files.length; i++) {
        const f = files[i];
        newFiles.push({ name: f.name, size: f.size, file: f });
      }
      setAttachedFiles((prev) => [...prev, ...newFiles]);
      // Reset input so same file can be re-attached
      e.target.value = "";
    },
    []
  );

  const removeAttachedFile = useCallback((index: number) => {
    setAttachedFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  // Close menus when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setCmdPaletteOpen(false);
        setCmdPaletteFilter(undefined);
        setPermMenuOpen(false);
        setModelMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const permLabel = getPermissionLabel(permissionMode);
  const contextPct = getContextPercentage(
    totalInputTokens,
    totalOutputTokens,
    model
  );

  return (
    <div
      className="input-container"
      data-permission-mode={permissionMode}
      ref={containerRef}
    >
      {/* Command palette popup */}
      {cmdPaletteOpen && (
        <SlashCommandMenu
          externalFilter={cmdPaletteFilter}
          model={model}
          thinkingEnabled={thinkingEnabled}
          effortLevel={effortLevel}
          onAction={handleCmdAction}
          onToggleThinking={handleToggleThinking}
          onEffortCycle={handleEffortCycle}
          onClose={() => {
            setCmdPaletteOpen(false);
            setCmdPaletteFilter(undefined);
          }}
        />
      )}

      {/* Permission mode menu popup */}
      {permMenuOpen && (
        <PermissionModeMenu
          currentMode={permissionMode}
          onSelect={(mode) => {
            onPermissionModeChange?.(mode);
            setPermMenuOpen(false);
          }}
          onClose={() => setPermMenuOpen(false)}
        />
      )}

      {/* Model selector menu popup */}
      {modelMenuOpen && (
        <ModelMenu
          currentModel={model}
          onSelect={(m) => {
            onModelChange?.(m);
            setModelMenuOpen(false);
          }}
          onClose={() => setModelMenuOpen(false)}
        />
      )}

      {/* Attached files */}
      {attachedFiles.length > 0 && (
        <div className="attached-files-container">
          {attachedFiles.map((f, i) => (
            <div key={i} className="attached-file">
              <span className="attached-file-name">{f.name}</span>
              <button
                className="attached-file-remove"
                onClick={() => removeAttachedFile(i)}
                title="Remove"
              >
                &times;
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Input area */}
      <div
        ref={inputRef}
        className="input-box"
        contentEditable={!disabled ? "plaintext-only" : "false"}
        role="textbox"
        aria-multiline="true"
        aria-label="Message Claude"
        data-placeholder={
          isStreaming
            ? "Press Enter to interrupt..."
            : "ctrl esc to focus or unfocus Claude"
        }
        onKeyDown={handleKeyDown}
        onInput={handleInput}
        suppressContentEditableWarning
      />

      {/* Footer bar */}
      <div className="input-footer">
        {/* 1. Permission mode button */}
        <button
          className="footer-button"
          title="Change permission mode (Shift+Tab)"
          data-mode={permissionMode}
          onClick={handlePermButtonClick}
        >
          <span className="footer-chevron">&raquo;</span>
          <span className="footer-button-label">{permLabel}</span>
        </button>

        {/* 2. Attached file indicators in footer */}
        {attachedFiles.length > 0 && (
          <span className="footer-attached-indicator" title="Files attached">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
            </svg>
            <span>{attachedFiles[0].name}</span>
          </span>
        )}

        {/* 3. Token/context usage */}
        {(totalInputTokens > 0 || totalOutputTokens > 0) && (
          <span className="context-indicator" title={`Input: ${totalInputTokens.toLocaleString()} | Output: ${totalOutputTokens.toLocaleString()} tokens`}>
            {contextPct}% context
          </span>
        )}

        {/* Spacer */}
        <div className="footer-spacer" />

        {/* 4. @ Attach button */}
        <button
          className="menu-button"
          title="Attach file"
          onClick={handleAttachClick}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
          </svg>
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          style={{ display: "none" }}
          onChange={handleFileChange}
        />

        {/* 5. / Command palette button */}
        <button
          className={`menu-button ${cmdPaletteOpen ? "menu-button-active" : ""}`}
          title="Commands"
          onClick={handleSlashButtonClick}
        >
          <span style={{ fontWeight: 700, fontSize: "1em" }}>/</span>
        </button>

        {/* 6. Send / Interrupt button */}
        <button
          className="send-button"
          onClick={doSend}
          disabled={disabled || (!isStreaming && isEmpty)}
          title={isStreaming ? "Interrupt (Escape)" : "Send (Enter)"}
          data-permission-mode={permissionMode}
        >
          {isStreaming ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          ) : (
            <SendArrowIcon />
          )}
        </button>
      </div>
    </div>
  );
}

// ============================================================
// Helpers
// ============================================================

interface AttachedFile {
  name: string;
  size: number;
  file: File;
}

function SendArrowIcon(): React.ReactElement {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M4.5 19.5L20 12 4.5 4.5v6l10 1.5-10 1.5z" />
    </svg>
  );
}

function getPermissionLabel(mode: string): string {
  switch (mode) {
    case "bypassPermissions":
      return "Bypass permissions";
    case "acceptEdits":
      return "Auto-accept";
    case "plan":
      return "Plan mode";
    case "default":
    default:
      return "Normal";
  }
}

/**
 * Estimate context usage percentage.
 * Context windows: Opus/Sonnet ~200K, Haiku ~200K.
 */
function getContextPercentage(
  inputTokens: number,
  outputTokens: number,
  model?: string
): number {
  const contextWindow = getContextWindow(model);
  const maxOutputTokens = 16384;
  const reserveTokens = 13000; // System prompt reserve
  const usableWindow = contextWindow - maxOutputTokens - reserveTokens;
  const used = inputTokens + outputTokens;
  const remaining = Math.max(0, usableWindow - used);
  return Math.round((remaining / usableWindow) * 100);
}

function getContextWindow(model?: string): number {
  if (!model) return 200000;
  if (model.includes("haiku")) return 200000;
  if (model.includes("opus")) return 200000;
  if (model.includes("sonnet")) return 200000;
  return 200000;
}
