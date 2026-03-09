/**
 * PermissionModeMenu — dropdown for switching permission modes.
 * Opens above the permission mode button in the input footer.
 */

import React, { useRef, useEffect, useState } from "react";

interface PermissionModeOption {
  value: string;
  label: string;
  description: string;
  shortcut?: string;
}

const PERMISSION_MODES: PermissionModeOption[] = [
  {
    value: "default",
    label: "Normal",
    description: "Claude asks before each tool use",
  },
  {
    value: "acceptEdits",
    label: "Auto-accept",
    description: "Accept file edits without confirmation",
  },
  {
    value: "plan",
    label: "Plan mode",
    description: "Claude plans without making changes",
  },
  {
    value: "bypassPermissions",
    label: "YOLO mode",
    description: "Skip all confirmations (use with caution)",
  },
];

interface Props {
  currentMode: string;
  onSelect: (mode: string) => void;
  onClose: () => void;
}

export function PermissionModeMenu({
  currentMode,
  onSelect,
  onClose,
}: Props): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, PERMISSION_MODES.findIndex((m) => m.value === currentMode))
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < PERMISSION_MODES.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : PERMISSION_MODES.length - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          onSelect(PERMISSION_MODES[selectedIndex].value);
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [selectedIndex, onSelect, onClose]);

  return (
    <div className="menu-popup perm-menu" ref={menuRef}>
      <div className="menu-popup-header">Permission Mode</div>
      {PERMISSION_MODES.map((mode, i) => (
        <button
          key={mode.value}
          className={`perm-menu-item ${i === selectedIndex ? "perm-menu-item-selected" : ""} ${mode.value === currentMode ? "perm-menu-item-active" : ""}`}
          onClick={() => onSelect(mode.value)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <div className="perm-menu-item-header">
            <span className="perm-menu-item-check">
              {mode.value === currentMode ? "●" : ""}
            </span>
            <span className="perm-menu-item-label">{mode.label}</span>
          </div>
          <div className="perm-menu-item-desc">{mode.description}</div>
        </button>
      ))}
    </div>
  );
}
