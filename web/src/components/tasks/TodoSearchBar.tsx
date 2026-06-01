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

// Debounce keystrokes (~0.5s buffer) before propagating to parent. The input
// value (localValue) stays immediate for typing feel; only the search trigger
// is debounced. Prevents the client-side filter useMemo in TodoPanel
// (~2600 tasks) and the server /api/search request from firing on every keystroke.
const INPUT_DEBOUNCE_MS = 500;

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
  // Tracks the last value this component propagated to the parent. The parent's
  // `query` prop lags behind our local input (it only updates after debounce),
  // so when it flows back via the effect below it can be a STALE value. Without
  // this guard, the sync-back would overwrite a freshly-typed character with the
  // old query — the dropped-keystroke bug (type "123" fast → parent echoes "1"
  // back → localValue reverts → "2" is lost → backend only ever sees "13").
  const lastPropagatedRef = useRef(query);

  // Only adopt EXTERNAL query changes (programmatic clear/set from parent).
  // Ignore the lagging echo of our own propagated value so the input never
  // reverts mid-typing.
  useEffect(() => {
    if (query !== lastPropagatedRef.current) {
      lastPropagatedRef.current = query;
      setLocalValue(query);
    }
  }, [query]);

  const propagate = useCallback((value: string) => {
    lastPropagatedRef.current = value;
    onQueryChange(value);
  }, [onQueryChange]);

  const handleChange = useCallback((value: string) => {
    setLocalValue(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Empty string propagates immediately (clear is snappy)
    if (value === '') {
      propagate('');
      return;
    }
    debounceRef.current = setTimeout(() => {
      propagate(value);
    }, INPUT_DEBOUNCE_MS);
  }, [propagate]);

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
      lastPropagatedRef.current = '';
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
            lastPropagatedRef.current = '';
            setLocalValue('');
            onClear();
          }}
          title="Clear search (Esc)"
        >
          &#x2715;
        </button>
      )}
      <MicButton size="sm" onTranscribe={(text) => { setLocalValue(text); propagate(text); }} />
    </div>
  );
}
