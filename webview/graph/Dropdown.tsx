/**
 * Dropdown — custom dropdown matching vscode-git-graph/web/dropdown.ts.
 * Supports single-select and multi-select with filter input.
 */

import React, { useState, useRef, useEffect, useCallback } from "react";

export interface DropdownOption {
  value: string;
  label: string;
  hint?: string;
}

interface DropdownProps {
  options: DropdownOption[];
  /** Currently selected value(s). For multi: array of values. For single: single value. */
  value: string | string[];
  /** Multi-select mode */
  multi?: boolean;
  /** Placeholder when nothing is selected */
  placeholder?: string;
  onChange: (values: string[]) => void;
}

export function Dropdown({
  options,
  value,
  multi,
  placeholder = "",
  onChange,
}: DropdownProps): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // Normalize value to array
  const selected = Array.isArray(value) ? value : value ? [value] : [];

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  // Focus filter on open
  useEffect(() => {
    if (open && filterRef.current) {
      filterRef.current.focus();
    }
  }, [open]);

  const toggle = useCallback(() => {
    setOpen((o) => !o);
    if (open) setFilter("");
  }, [open]);

  const handleSelect = useCallback(
    (val: string) => {
      if (multi) {
        const next = selected.includes(val)
          ? selected.filter((v) => v !== val)
          : [...selected, val];
        onChange(next);
      } else {
        onChange([val]);
        setOpen(false);
        setFilter("");
      }
    },
    [multi, selected, onChange]
  );

  // Display text
  const displayText = (() => {
    if (selected.length === 0) return placeholder;
    if (multi) {
      if (selected.length === options.length || selected.length === 0) return "All";
      if (selected.length === 1) {
        const opt = options.find((o) => o.value === selected[0]);
        return opt?.label ?? selected[0];
      }
      return `${selected.length} selected`;
    }
    const opt = options.find((o) => o.value === selected[0]);
    return opt?.label ?? selected[0];
  })();

  // Filter options
  const lowerFilter = filter.toLowerCase();
  const filtered = filter
    ? options.filter((o) => o.label.toLowerCase().includes(lowerFilter))
    : options;

  return (
    <div
      className={`dropdown loaded${open ? " dropdownOpen" : ""}${multi ? " multi" : ""}`}
      ref={containerRef}
    >
      <div className="dropdownCurrentValue" onClick={toggle}>
        {displayText}
      </div>
      {open && (
        <div className="dropdownMenu">
          {options.length > 5 && (
            <div className="dropdownFilter">
              <input
                ref={filterRef}
                className="dropdownFilterInput"
                type="text"
                placeholder="Filter..."
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          )}
          <div className="dropdownOptions">
            {filtered.length === 0 ? (
              <div className="dropdownNoResults">No results</div>
            ) : (
              filtered.map((opt) => {
                const isSelected = selected.includes(opt.value);
                return (
                  <div
                    key={opt.value}
                    className={`dropdownOption${isSelected ? " selected" : ""}`}
                    onClick={() => handleSelect(opt.value)}
                  >
                    {multi && (
                      <span className="dropdownOptionMultiSelected">
                        {isSelected && (
                          <svg xmlns="http://www.w3.org/2000/svg" width="12" height="12" viewBox="0 0 24 24">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                          </svg>
                        )}
                      </span>
                    )}
                    {opt.label}
                    {opt.hint && <span className="dropdownOptionHint">{opt.hint}</span>}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
