/**
 * TodoSearchBar — search input for the TODO panel.
 * Renders between category tabs and filter toolbar.
 */

import { useRef, useEffect, useCallback, useState } from 'react';
import { ICON_SEARCH } from '@/components/common/Icons';
import { MicButton } from '../common/MicButton';

interface TodoSearchBarProps {
  query: string;
  onQueryChange: (q: string) => void;
  onClear: () => void;
  isSearching: boolean;
  resultCount?: number | null; // null = no server results yet
}

// Debounce keystrokes before propagating to parent. Prevents the client-side
// filter useMemo in TodoPanel (~2600 tasks × ~10 string matches) from re-running
// on every keystroke. Input value remains immediate for typing feel.
const INPUT_DEBOUNCE_MS = 120;

export function TodoSearchBar({
  query,
  onQueryChange,
  onClear,
  isSearching,
  resultCount,
}: TodoSearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [localValue, setLocalValue] = useState(query);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync external query changes (clear, programmatic updates) into local input
  useEffect(() => {
    setLocalValue(query);
  }, [query]);

  const handleChange = useCallback((value: string) => {
    setLocalValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Empty string propagates immediately (clear is snappy)
    if (value === '') {
      onQueryChange('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      onQueryChange(value);
    }, INPUT_DEBOUNCE_MS);
  }, [onQueryChange]);

  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // Keyboard shortcut: Cmd+K or / to focus
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Cmd+K (Mac) or Ctrl+K (Windows)
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        return;
      }
      // / key when no editable element is focused
      if (e.key === '/' && document.activeElement?.tagName !== 'INPUT' && document.activeElement?.tagName !== 'TEXTAREA' && !(document.activeElement as HTMLElement)?.isContentEditable) {
        e.preventDefault();
        inputRef.current?.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      setLocalValue('');
      onClear();
      inputRef.current?.blur();
    }
  }, [onClear]);

  return (
    <div className="todo-search-bar">
      <span className="todo-search-icon">{ICON_SEARCH}</span>
      <input
        ref={inputRef}
        type="text"
        className="todo-search-input"
        placeholder="Search tasks...  &#x2318;K"
        value={localValue}
        onChange={(e) => handleChange(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {isSearching && <span className="todo-search-spinner" />}
      {query && !isSearching && resultCount != null && (
        <span className="todo-search-count">{resultCount}</span>
      )}
      {localValue && (
        <button
          className="todo-search-clear"
          onClick={() => {
            if (debounceRef.current) clearTimeout(debounceRef.current);
            setLocalValue('');
            onClear();
          }}
          title="Clear search (Esc)"
        >
          &#x2715;
        </button>
      )}
      <MicButton size="sm" onTranscribe={(text) => { setLocalValue(text); onQueryChange(text); }} />
    </div>
  );
}
