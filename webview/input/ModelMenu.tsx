/**
 * ModelMenu — dropdown for switching AI models.
 * Opens above the model indicator in the input footer.
 */

import React, { useRef, useEffect, useState } from "react";

interface ModelOption {
  id: string;
  label: string;
  description: string;
}

const AVAILABLE_MODELS: ModelOption[] = [
  {
    id: "claude-opus-4-6",
    label: "Opus 4.6",
    description: "Most capable, best for complex tasks",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Balanced speed and capability",
  },
  {
    id: "claude-haiku-4-5-20251001",
    label: "Haiku 4.5",
    description: "Fastest, best for simple tasks",
  },
];

interface Props {
  currentModel?: string;
  onSelect: (model: string) => void;
  onClose: () => void;
}

export function ModelMenu({
  currentModel,
  onSelect,
  onClose,
}: Props): React.ReactElement {
  const menuRef = useRef<HTMLDivElement>(null);
  const [selectedIndex, setSelectedIndex] = useState(() =>
    Math.max(0, AVAILABLE_MODELS.findIndex((m) => currentModel?.includes(m.id)))
  );

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev < AVAILABLE_MODELS.length - 1 ? prev + 1 : 0
          );
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            prev > 0 ? prev - 1 : AVAILABLE_MODELS.length - 1
          );
          break;
        case "Enter":
          e.preventDefault();
          onSelect(AVAILABLE_MODELS[selectedIndex].id);
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
    <div className="menu-popup model-menu" ref={menuRef}>
      <div className="menu-popup-header">Model</div>
      {AVAILABLE_MODELS.map((model, i) => (
        <button
          key={model.id}
          className={`model-menu-item ${i === selectedIndex ? "model-menu-item-selected" : ""} ${currentModel?.includes(model.id) ? "model-menu-item-active" : ""}`}
          onClick={() => onSelect(model.id)}
          onMouseEnter={() => setSelectedIndex(i)}
        >
          <div className="model-menu-item-header">
            <span className="model-menu-item-check">
              {currentModel?.includes(model.id) ? "●" : ""}
            </span>
            <span className="model-menu-item-label">{model.label}</span>
          </div>
          <div className="model-menu-item-desc">{model.description}</div>
        </button>
      ))}
    </div>
  );
}
