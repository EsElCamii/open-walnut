import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const TODO_PANEL_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/components/tasks/TodoPanel.tsx'),
  'utf8'
);
const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8'
);

describe('TodoPanel layout: actions in bottom row', () => {
  it('todo-item-actions is inside todo-item-content, not a sibling', () => {
    // In the new layout, within the SortableTaskItem return JSX,
    // "todo-item-actions" appears BETWEEN "todo-item-content" open and its closing
    const contentIdx = TODO_PANEL_SRC.indexOf('"todo-item-content"');
    const actionsIdx = TODO_PANEL_SRC.indexOf('"todo-item-actions"');
    expect(contentIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeGreaterThan(-1);
    expect(actionsIdx).toBeGreaterThan(contentIdx);

    // Verify actions is NOT a direct child of todo-panel-item at the same level
    // Old pattern: </div>\n\n      {/* — action badges */}\n      <div className="todo-item-actions">
    // New pattern: actions is indented deeper (inside content)
    const lines = TODO_PANEL_SRC.split('\n');
    const contentLine = lines.findIndex(l => l.includes('"todo-item-content"'));
    const actionsLine = lines.findIndex(l => l.includes('"todo-item-actions"'));
    const contentIndent = lines[contentLine].match(/^\s*/)?.[0].length ?? 0;
    const actionsIndent = lines[actionsLine].match(/^\s*/)?.[0].length ?? 0;
    // Actions should be MORE indented than content (it's a child, not a sibling)
    expect(actionsIndent).toBeGreaterThan(contentIndent);
  });

  it('TaskStatusDot is in actions row, not meta-row', () => {
    const metaRowIdx = TODO_PANEL_SRC.indexOf('"todo-item-meta-row"');
    const actionsIdx = TODO_PANEL_SRC.indexOf('"todo-item-actions"');
    // Find TaskStatusDot usage in the SortableTaskItem function
    const taskStatusDotIdx = TODO_PANEL_SRC.indexOf('<TaskStatusDot', actionsIdx);
    expect(taskStatusDotIdx).toBeGreaterThan(actionsIdx);
    // TaskStatusDot should NOT appear between meta-row open and actions open
    const metaRegion = TODO_PANEL_SRC.slice(metaRowIdx, actionsIdx);
    expect(metaRegion).not.toContain('TaskStatusDot');
  });

  it('CSS: .todo-item-actions has margin-top, no flex-shrink: 0', () => {
    // Extract the .todo-item-actions CSS block
    const blockStart = CSS_SRC.indexOf('.todo-item-actions {');
    expect(blockStart).toBeGreaterThan(-1);
    const blockEnd = CSS_SRC.indexOf('}', blockStart);
    const block = CSS_SRC.slice(blockStart, blockEnd + 1);
    expect(block).toContain('margin-top');
    expect(block).not.toContain('flex-shrink: 0');
    expect(block).toContain('display: flex');
  });
});
