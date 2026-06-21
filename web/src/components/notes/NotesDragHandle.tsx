/**
 * Hover gutter for reordering blocks: a `⠿` grip (positioned by
 * @tiptap/extension-drag-handle-react) + a `＋` inserter that opens the slash
 * menu to add a block below the hovered one.
 *
 * The grip supports BOTH affordances, disambiguated by gesture:
 *   • CLICK (press without moving) → opens a small actions menu (Move up /
 *     Move down / Delete) — keyboard-free, always-works fallback.
 *   • DRAG (press + move past a threshold) → a real pointer-driven drag that
 *     shows a drop indicator line between blocks and, on release, moves the
 *     block to that slot.
 *
 * WHY A CUSTOM POINTER DRAG INSTEAD OF THE EXTENSION'S NATIVE HTML5 DRAG:
 * The extension sets `element.draggable = true` and lets ProseMirror's native
 * drop apply a `view.dragging` slice as delete+insert. With our custom nodes
 * (tag / callout / table / wiki-embed) + tiptap-markdown serialization that
 * native move transaction is destructive — text vanished on drop (the original
 * bug). So we KILL the native dragstart (capture-phase preventDefault) and drive
 * reordering ourselves with mousedown/mousemove/mouseup, executing the SAME
 * validated whole-node move transaction the menu uses (`moveBlockToIndex`, which
 * runs `tr.doc.check()` and bails to a no-op on any malformed shape). Net: real
 * drag-to-reorder, zero data loss, and it's driveable by Playwright's mouse API
 * (native HTML5 drag is not, which is how the earlier "verified" pass missed
 * that native drag had been reduced to a no-op).
 *
 * Pure overlay: every mutation is one ProseMirror transaction routed through
 * onUpdate, so it rides the existing isSourceRef save path (clean Markdown, one
 * Cmd+Z per action).
 */

import { useRef, useState, useCallback, useEffect } from 'react';
import { DragHandle } from '@tiptap/extension-drag-handle-react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { log } from '@/utils/log';

interface NotesDragHandleProps {
  editor: Editor;
  /** Open the insert menu anchored below the block at `pos`. */
  onInsertBelow: (pos: number) => void;
}

/** Px the pointer must move after mousedown before it counts as a drag (not a click). */
const DRAG_THRESHOLD = 4;

export function NotesDragHandle({ editor, onInsertBelow }: NotesDragHandleProps) {
  // Latest hovered top-level block (node + its document position).
  const hovered = useRef<{ node: PMNode | null; pos: number }>({ node: null, pos: -1 });
  const [menuOpen, setMenuOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const gripRef = useRef<HTMLButtonElement | null>(null);

  // Kill the extension's native HTML5 press-drag at the source (the lossy path —
  // see file header). Capture-phase listener on the portal element fires before
  // the extension's bubble-phase onDragStart, so its dragHandler() — which sets
  // view.dragging — never runs. We do NOT lock the handle (that would freeze
  // hover-follow + onNodeChange, which the menu and our drag both depend on).
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    const portal = gripRef.current?.closest<HTMLElement>('.notes-drag-handle');
    if (!portal) return;
    const kill = (e: DragEvent) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    portal.addEventListener('dragstart', kill, true);
    return () => portal.removeEventListener('dragstart', kill, true);
  }, [editor, menuOpen, dragging]);

  const handleElementDragStart = useCallback((e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleNodeChange = useCallback((data: { node: PMNode | null; pos: number }) => {
    hovered.current = { node: data.node, pos: data.pos };
    setMenuOpen(false);
  }, []);

  const selectHovered = useCallback((): boolean => {
    const { pos } = hovered.current;
    if (pos < 0 || pos > editor.state.doc.content.size) return false;
    try {
      const sel = NodeSelection.create(editor.state.doc, pos);
      editor.view.dispatch(editor.state.tr.setSelection(sel));
      return true;
    } catch (err) {
      log.warn('notes', 'drag-handle selectHovered failed', { pos, error: String(err) });
      return false;
    }
  }, [editor]);

  const moveBlock = useCallback((dir: -1 | 1) => {
    const { pos } = hovered.current;
    if (pos < 0) return;
    const fromIdx = topLevelIndexAtPos(editor, pos);
    if (fromIdx < 0) return;
    const moved = moveBlockToIndex(editor, fromIdx, fromIdx + dir);
    if (!moved) log.info('notes', 'drag-handle move had no effect', { dir });
    setMenuOpen(false);
  }, [editor]);

  const deleteBlock = useCallback(() => {
    if (!selectHovered()) return;
    editor.chain().focus().deleteSelection().run();
    setMenuOpen(false);
  }, [editor, selectHovered]);

  const handleInsert = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const { pos, node } = hovered.current;
    if (pos < 0 || !node) return;
    onInsertBelow(pos + node.nodeSize);
  }, [onInsertBelow]);

  // Press the grip: start tracking. If the pointer moves past the threshold it
  // becomes a drag (with a live drop indicator); if released without moving, it
  // is treated as a click and toggles the actions menu.
  const handleGripMouseDown = useCallback((e: React.MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    const startY = e.clientY;
    const fromIdx = hovered.current.pos >= 0 ? topLevelIndexAtPos(editor, hovered.current.pos) : -1;

    let isDrag = false;
    let dropIdx = -1; // insert-before index in top-level child terms
    const indicator = makeDropIndicator();

    const onMove = (ev: MouseEvent) => {
      if (!isDrag) {
        if (Math.abs(ev.clientX - startX) < DRAG_THRESHOLD && Math.abs(ev.clientY - startY) < DRAG_THRESHOLD) return;
        // Cross the threshold → enter drag mode.
        isDrag = true;
        setMenuOpen(false);
        setDragging(true);
        document.body.classList.add('notes-block-dragging');
      }
      dropIdx = dropIndexAtClientY(editor, ev.clientY);
      positionDropIndicator(editor, indicator, dropIdx);
    };

    const onUp = () => {
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('mouseup', onUp, true);
      indicator.remove();
      if (!isDrag) {
        // Was a click, not a drag → open the actions menu.
        setMenuOpen(o => !o);
        return;
      }
      document.body.classList.remove('notes-block-dragging');
      setDragging(false);
      if (fromIdx >= 0 && dropIdx >= 0) {
        // dropIdx is an insert-before slot; convert to a destination index.
        const dest = dropIdx > fromIdx ? dropIdx - 1 : dropIdx;
        if (dest !== fromIdx) {
          const moved = moveBlockToIndex(editor, fromIdx, dest);
          if (!moved) log.info('notes', 'drag reorder had no effect', { fromIdx, dest });
        }
      }
    };

    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('mouseup', onUp, true);
  }, [editor]);

  return (
    <DragHandle
      editor={editor}
      onNodeChange={handleNodeChange}
      onElementDragStart={handleElementDragStart}
      className="notes-drag-handle"
    >
      <div className="notes-drag-handle-inner">
        <button
          type="button"
          className="notes-drag-add"
          title="Insert block below"
          onMouseDown={handleInsert}
        >+</button>
        <button
          ref={gripRef}
          type="button"
          className={`notes-drag-grip${dragging ? ' is-dragging' : ''}`}
          title="Drag to move · click for actions"
          onMouseDown={handleGripMouseDown}
        >⠿</button>

        {menuOpen && (
          <div className="notes-block-actions" onMouseLeave={() => setMenuOpen(false)}>
            <button type="button" onMouseDown={(e) => { e.preventDefault(); moveBlock(-1); }}>↑ Move up</button>
            <button type="button" onMouseDown={(e) => { e.preventDefault(); moveBlock(1); }}>↓ Move down</button>
            <button type="button" className="danger" onMouseDown={(e) => { e.preventDefault(); deleteBlock(); }}>✕ Delete</button>
          </div>
        )}
      </div>
    </DragHandle>
  );
}

// ─── Top-level block helpers ───────────────────────────────────────────────

/** The doc-child index of the top-level block containing `pos`, or -1. */
function topLevelIndexAtPos(editor: Editor, pos: number): number {
  const { doc } = editor.state;
  if (pos < 0 || pos > doc.content.size) return -1;
  try {
    const $pos = doc.resolve(pos);
    // A NodeSelection-style pos points AT the node; resolve(pos+1) sits inside it.
    // Walk to depth 1 to get the top-level index.
    if ($pos.depth === 0) {
      // pos is between top-level nodes; the node starting here is index($pos.index()).
      return Math.min($pos.index(), doc.childCount - 1);
    }
    return $pos.index(0);
  } catch {
    return -1;
  }
}

/**
 * Move the top-level block at `fromIdx` to `destIdx` (both in doc-child terms)
 * using a single validated transaction. Returns false (no-op) if indices are
 * out of range, equal, or the result fails ProseMirror's structural check —
 * so a malformed shape can NEVER produce a destructive transaction.
 *
 * Routed through `editor.commands.command(...)` (NOT a raw `editor.view.dispatch`)
 * so the mutation goes through TipTap's command pipeline and fires `onUpdate` →
 * the debounced autosave in useNoteContent. A raw view.dispatch reorders the doc
 * but does NOT mark the editor dirty, so the change silently reverts on reload
 * until the next keystroke — that was a real persistence bug. The command path
 * keeps it a single transaction (one Cmd+Z) AND triggers the save.
 */
function moveBlockToIndex(editor: Editor, fromIdx: number, destIdx: number): boolean {
  const { doc } = editor.state;
  if (fromIdx < 0 || fromIdx >= doc.childCount) return false;
  if (destIdx < 0 || destIdx >= doc.childCount) return false;
  if (fromIdx === destIdx) return false;

  // Absolute position where each top-level child starts.
  const childStart = (idx: number): number => {
    let p = 0;
    for (let i = 0; i < idx; i++) p += doc.child(i).nodeSize;
    return p;
  };

  return editor
    .chain()
    .focus()
    .command(({ tr, dispatch }) => {
      const node = doc.child(fromIdx);
      const from = childStart(fromIdx);
      const to = from + node.nodeSize;

      tr.delete(from, to);
      // After deletion, map the original destination child-start through the
      // step to get the insert position in the mutated doc.
      const destStartOriginal = childStart(destIdx > fromIdx ? destIdx + 1 : destIdx);
      const insertAt = tr.mapping.map(destStartOriginal);
      tr.insert(insertAt, node);
      tr.setSelection(NodeSelection.create(tr.doc, insertAt));
      tr.scrollIntoView();

      try { tr.doc.check(); } catch (err) {
        // Bail to a no-op: returning false (without dispatch) discards tr, so a
        // malformed shape can never produce a destructive/persisted transaction.
        log.warn('notes', 'moveBlockToIndex produced invalid doc — aborting', { fromIdx, destIdx, error: String(err) });
        return false;
      }
      dispatch?.(tr);
      return true;
    })
    .run();
}

// ─── Drop-indicator helpers (pointer drag) ─────────────────────────────────

/** Create the floating drop-indicator line element appended to <body>. */
function makeDropIndicator(): HTMLElement {
  const el = document.createElement('div');
  el.className = 'notes-drop-indicator';
  el.style.position = 'fixed';
  el.style.display = 'none';
  el.style.pointerEvents = 'none';
  el.style.zIndex = '9999';
  document.body.appendChild(el);
  return el;
}

/**
 * Given a client Y, return the insert-before slot among top-level blocks:
 * 0..childCount. Uses each block's DOM rect midpoint to decide above/below.
 */
function dropIndexAtClientY(editor: Editor, clientY: number): number {
  const { doc } = editor.state;
  let pos = 0;
  for (let i = 0; i < doc.childCount; i++) {
    const node = doc.child(i);
    try {
      const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
      if (dom && dom.getBoundingClientRect) {
        const rect = dom.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) return i;
      }
    } catch { /* skip */ }
    pos += node.nodeSize;
  }
  return doc.childCount; // below the last block
}

/** Position the indicator line at the boundary before top-level block `idx`. */
function positionDropIndicator(editor: Editor, el: HTMLElement, idx: number): void {
  const { doc } = editor.state;
  const editorDom = editor.view.dom as HTMLElement;
  const edRect = editorDom.getBoundingClientRect();

  let top: number;
  let pos = 0;
  if (idx >= doc.childCount && doc.childCount > 0) {
    // After the last block.
    let last = 0;
    for (let i = 0; i < doc.childCount - 1; i++) last += doc.child(i).nodeSize;
    const dom = editor.view.nodeDOM(last) as HTMLElement | null;
    const rect = dom?.getBoundingClientRect();
    top = rect ? rect.bottom : edRect.bottom;
  } else {
    for (let i = 0; i < idx; i++) pos += doc.child(i).nodeSize;
    const dom = editor.view.nodeDOM(pos) as HTMLElement | null;
    const rect = dom?.getBoundingClientRect();
    top = rect ? rect.top : edRect.top;
  }

  el.style.display = 'block';
  el.style.left = `${edRect.left}px`;
  el.style.width = `${edRect.width}px`;
  el.style.top = `${top - 1}px`;
}
