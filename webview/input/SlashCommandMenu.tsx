/**
 * SlashCommandMenu — full command palette matching original Claude Code extension.
 * Organized by sections: Context, Model, Customize, Commands.
 * Filter input at top, section headers, right-side accessories (text, icon, toggle).
 *
 * Exact original behavior:
 * - Effort: 4 levels (low/medium/high/max), cycles on click, keepMenuOpen
 * - Thinking: toggles on/off, keepMenuOpen
 * - Section dividers: 1px lines between sections
 * - Effort icon: 4 ascending bars, heights [5,8,11,14] in viewBox 0 0 16 14
 * - Toggle switch: 32x18 track, 14x14 thumb with checkmark
 */

import React, { useMemo, useState, useCallback, useEffect, useRef } from "react";

// ============================================================
// Types
// ============================================================

export interface SlashCommand {
  name: string;
  description: string;
}

export type MenuItemType = "action" | "toggle" | "info";

export interface MenuItem {
  id: string;
  label: string;
  section: string;
  type: MenuItemType;
  rightText?: string;
  rightIcon?: "effort";
  toggled?: boolean;
  slashCommand?: string;
  /** If true, clicking this item does NOT close the menu */
  keepMenuOpen?: boolean;
}

export interface MenuSection {
  id: string;
  label: string;
  items: MenuItem[];
}

interface Props {
  externalFilter?: string;
  model?: string;
  thinkingEnabled: boolean;
  /** "low" | "medium" | "high" | "max" */
  effortLevel: string;
  onAction: (actionId: string) => void;
  onToggleThinking: (enabled: boolean) => void;
  onEffortCycle: () => void;
  onClose: () => void;
}

// ============================================================
// Effort level mapping — matches CN1 in original
// ============================================================

const EFFORT_BARS: Record<string, number> = { low: 1, medium: 2, high: 3, max: 4 };
const EFFORT_LEVELS = ["low", "medium", "high", "max"] as const;
/** Bar heights matching original SN1=[5,8,11,14] */
const BAR_HEIGHTS = [5, 8, 11, 14];

// ============================================================
// Build menu sections
// ============================================================

function buildSections(
  model: string | undefined,
  thinkingEnabled: boolean,
  effortLevel: string,
): MenuSection[] {
  const formatModel = (m?: string): string => {
    if (!m || m === "default") return "Opus";
    if (m.includes("opus-4-6") || m.includes("opus-4.6")) return "Opus";
    if (m.includes("sonnet-4-6") || m.includes("sonnet-4.6")) return "Sonnet";
    if (m.includes("haiku-4-5") || m.includes("haiku-4.5")) return "Haiku";
    if (m.includes("opus")) return "Opus";
    if (m.includes("sonnet")) return "Sonnet";
    if (m.includes("haiku")) return "Haiku";
    return m;
  };

  return [
    {
      id: "context",
      label: "Context",
      items: [
        { id: "attach-file", label: "Attach file...", section: "context", type: "action" },
        { id: "mention-file", label: "Mention file from this project...", section: "context", type: "action" },
        { id: "clear", label: "Clear conversation", section: "context", type: "action", slashCommand: "clear" },
      ],
    },
    {
      id: "model",
      label: "Model",
      items: [
        { id: "switch-model", label: "Switch model...", section: "model", type: "action", rightText: formatModel(model) },
        { id: "effort", label: "Effort", section: "model", type: "action", rightIcon: "effort", keepMenuOpen: true },
        { id: "thinking", label: "Thinking", section: "model", type: "toggle", toggled: thinkingEnabled, keepMenuOpen: true },
        { id: "account-usage", label: "Account & usage...", section: "model", type: "action" },
        { id: "fast-mode", label: "Toggle fast mode (Opus 4.6 only)", section: "model", type: "action" },
      ],
    },
    {
      id: "customize",
      label: "Customize",
      items: [
        { id: "add-slash-cmd", label: "Add custom slash command", section: "customize", type: "action" },
        { id: "add-claude-md", label: "Add to CLAUDE.md...", section: "customize", type: "action", slashCommand: "memory" },
        { id: "manage-mcp", label: "Manage MCP servers...", section: "customize", type: "action" },
      ],
    },
    {
      id: "commands",
      label: "Commands",
      items: [
        { id: "cmd-bug", label: "/bug", section: "commands", type: "action", slashCommand: "bug" },
        { id: "cmd-compact", label: "/compact", section: "commands", type: "action", slashCommand: "compact" },
        { id: "cmd-config", label: "/config", section: "commands", type: "action", slashCommand: "config" },
        { id: "cmd-cost", label: "/cost", section: "commands", type: "action", slashCommand: "cost" },
        { id: "cmd-doctor", label: "/doctor", section: "commands", type: "action", slashCommand: "doctor" },
        { id: "cmd-help", label: "/help", section: "commands", type: "action", slashCommand: "help" },
        { id: "cmd-init", label: "/init", section: "commands", type: "action", slashCommand: "init" },
        { id: "cmd-login", label: "/login", section: "commands", type: "action", slashCommand: "login" },
        { id: "cmd-logout", label: "/logout", section: "commands", type: "action", slashCommand: "logout" },
        { id: "cmd-permissions", label: "/permissions", section: "commands", type: "action", slashCommand: "permissions" },
        { id: "cmd-review", label: "/review", section: "commands", type: "action", slashCommand: "review" },
        { id: "cmd-status", label: "/status", section: "commands", type: "action", slashCommand: "status" },
        { id: "cmd-vim", label: "/vim", section: "commands", type: "action", slashCommand: "vim" },
      ],
    },
  ];
}

// ============================================================
// Component
// ============================================================

export function SlashCommandMenu({
  externalFilter,
  model,
  thinkingEnabled,
  effortLevel,
  onAction,
  onToggleThinking,
  onEffortCycle,
  onClose,
}: Props): React.ReactElement {
  const [filterText, setFilterText] = useState(externalFilter ?? "");
  const [selectedFlatIndex, setSelectedFlatIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Sync external filter into local state
  useEffect(() => {
    if (externalFilter !== undefined) {
      setFilterText(externalFilter);
    }
  }, [externalFilter]);

  // Build + filter sections
  const allSections = useMemo(
    () => buildSections(model, thinkingEnabled, effortLevel),
    [model, thinkingEnabled, effortLevel]
  );

  const filteredSections = useMemo(() => {
    if (!filterText) return allSections;
    const lower = filterText.toLowerCase();
    return allSections
      .map((section) => ({
        ...section,
        items: section.items.filter(
          (item) =>
            item.label.toLowerCase().includes(lower) ||
            (item.slashCommand && item.slashCommand.toLowerCase().includes(lower)) ||
            (item.rightText && item.rightText.toLowerCase().includes(lower)) ||
            section.label.toLowerCase().includes(lower)
        ),
      }))
      .filter((section) => section.items.length > 0);
  }, [allSections, filterText]);

  // Flatten filtered items for keyboard navigation
  const flatItems = useMemo(() => {
    const items: MenuItem[] = [];
    for (const section of filteredSections) {
      for (const item of section.items) {
        items.push(item);
      }
    }
    return items;
  }, [filteredSections]);

  // Clamp selection when items change
  useEffect(() => {
    setSelectedFlatIndex((prev) => Math.min(prev, Math.max(0, flatItems.length - 1)));
  }, [flatItems.length]);

  // Reset selection on filter change
  useEffect(() => {
    setSelectedFlatIndex(0);
  }, [filterText]);

  // Focus filter input on mount
  useEffect(() => {
    filterRef.current?.focus();
  }, []);

  // Execute action on item
  const executeItem = useCallback(
    (item: MenuItem) => {
      if (item.type === "toggle") {
        onToggleThinking(!item.toggled);
        return; // keepMenuOpen for toggle
      }
      if (item.id === "effort") {
        onEffortCycle();
        return; // keepMenuOpen for effort
      }
      onAction(item.id);
    },
    [onAction, onToggleThinking, onEffortCycle]
  );

  // Keyboard navigation
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          e.stopPropagation();
          setSelectedFlatIndex((prev) =>
            prev < flatItems.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          e.stopPropagation();
          setSelectedFlatIndex((prev) =>
            prev > 0 ? prev - 1 : flatItems.length - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          e.stopPropagation();
          if (flatItems[selectedFlatIndex]) {
            executeItem(flatItems[selectedFlatIndex]);
          }
          break;
        case "Escape":
          e.preventDefault();
          e.stopPropagation();
          onClose();
          break;
        case "Tab":
          e.preventDefault();
          e.stopPropagation();
          if (flatItems[selectedFlatIndex]) {
            executeItem(flatItems[selectedFlatIndex]);
          }
          break;
      }
    },
    [flatItems, selectedFlatIndex, executeItem, onClose]
  );

  // Scroll selected item into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = list.querySelectorAll("[data-menu-item]");
    const selected = items[selectedFlatIndex] as HTMLElement;
    if (selected) {
      selected.scrollIntoView({ block: "nearest" });
    }
  }, [selectedFlatIndex]);

  // Track flat index as we render sections
  let flatIdx = 0;

  return (
    <div className="menu-popup cmd-palette" ref={menuRef} onKeyDown={handleKeyDown}>
      {/* Filter input */}
      <div className="cmd-palette-filter-row">
        <input
          ref={filterRef}
          className="cmd-palette-filter"
          type="text"
          placeholder="Filter actions..."
          value={filterText}
          onChange={(e) => setFilterText(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </div>

      {/* Scrollable sections */}
      <div className="cmd-palette-body" ref={listRef}>
        {filteredSections.length === 0 && (
          <div className="cmd-palette-empty">No matching actions</div>
        )}

        {filteredSections.map((section, sectionIdx) => (
          <div key={section.id} className="cmd-palette-section">
            {/* Section divider — between sections (not before first) */}
            {sectionIdx > 0 && <div className="cmd-palette-divider" />}
            <div className="cmd-palette-section-header">{section.label}</div>
            {section.items.map((item) => {
              const thisIdx = flatIdx++;
              const isSelected = thisIdx === selectedFlatIndex;
              return (
                <button
                  key={item.id}
                  data-menu-item
                  className={`cmd-palette-item ${isSelected ? "cmd-palette-item-selected" : ""}`}
                  onClick={() => executeItem(item)}
                  onMouseEnter={() => setSelectedFlatIndex(thisIdx)}
                >
                  <span className="cmd-palette-item-label">{item.label}</span>
                  <span className="cmd-palette-item-right">
                    {item.rightText && (
                      <span className="cmd-palette-item-value">{item.rightText}</span>
                    )}
                    {item.rightIcon === "effort" && (
                      <EffortIcon level={effortLevel} />
                    )}
                    {item.type === "toggle" && (
                      <ToggleSwitch enabled={!!item.toggled} />
                    )}
                  </span>
                </button>
              );
            })}
          </div>
        ))}
      </div>
    </div>
  );
}

// ============================================================
// Sub-components — exact match to original
// ============================================================

/**
 * Effort bar-chart icon — 4 ascending bars.
 * SVG viewBox: 0 0 16 14
 * Bar heights: [5, 8, 11, 14] (original SN1)
 * Active bars determined by CN1 = {low:1, medium:2, high:3, max:4}
 */
function EffortIcon({ level }: { level: string }): React.ReactElement {
  const activeBars = EFFORT_BARS[level] ?? 0;
  return (
    <svg width="16" height="14" viewBox="0 0 16 14" className="effort-icon">
      {BAR_HEIGHTS.map((h, i) => (
        <rect
          key={i}
          x={i * 4}
          y={14 - h}
          width="3"
          height={h}
          rx="0.5"
          fill="currentColor"
          opacity={i < activeBars ? 1 : 0.15}
        />
      ))}
    </svg>
  );
}

/**
 * Toggle switch — matches original Ba component.
 * Track: 32x18, thumb: 14x14, checkmark SVG when on.
 * Colors: off = var(--app-input-border), on = var(--app-accent-color, #06c)
 */
function ToggleSwitch({ enabled }: { enabled: boolean }): React.ReactElement {
  return (
    <div className="toggle-sw">
      <div className={`toggle-sw-track ${enabled ? "toggle-sw-track-on" : ""}`}>
        <div className={`toggle-sw-thumb ${enabled ? "toggle-sw-thumb-on" : ""}`}>
          {enabled && (
            <svg className="toggle-sw-check" width="8" height="8" viewBox="0 0 8 8" fill="none">
              <path d="M1 4L3 6L7 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
