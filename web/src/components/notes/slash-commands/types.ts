/** Slash command system types for the Global Notes editor. */

import type { Editor, Range } from '@tiptap/core';
import { insertBlock } from '../block-transforms';
import type { BlockKind } from '../block-transforms';

/**
 * Command "class" drives the trigger split (§3.3 of IMPL-CONTRACT):
 * - 'block': insert-block entries that should ONLY fire when the cursor sits in
 *   an empty/whitespace block (so `/` mid-sentence does not pop a block menu).
 * - 'reference': inline references (task / link-to-note) that must STILL fire
 *   mid-sentence, because you reference a task while writing a paragraph.
 */
export type SlashCommandClass = 'block' | 'reference';

/** Visual grouping in the menu. */
export type SlashCommandGroup = 'basic' | 'lists' | 'blocks' | 'reference';

export interface NoteSlashCommand {
  name: string;
  description: string;
  icon: string;
  /** Extra fuzzy-match terms (e.g. 'h1' aliases ['heading','title']). */
  aliases: string[];
  group: SlashCommandGroup;
  commandClass: SlashCommandClass;
  /**
   * Either a self-contained block insert (`run`) OR a `subPanel` key that opens
   * a secondary panel (task search / [[ note picker). Exactly one is set.
   */
  run?: (editor: Editor, range: Range) => void;
  subPanel?: 'task-search' | 'note-link';
}

export interface SlashRange {
  from: number;
  to: number;
}

export type SlashCommandState =
  | { phase: 'closed' }
  | { phase: 'commands'; range: SlashRange; query: string };

/** Helper to build a block-insert command from a BlockKind. */
function blockCmd(
  name: string,
  description: string,
  icon: string,
  kind: BlockKind,
  group: SlashCommandGroup,
  aliases: string[] = [],
): NoteSlashCommand {
  return {
    name,
    description,
    icon,
    aliases,
    group,
    commandClass: 'block',
    run: (editor, range) => { insertBlock(editor, kind, range); },
  };
}

/**
 * Notion-style block catalog. Order = display order within the (already
 * grouped) list. Headings/lists/quote/code/divider all reuse commands TipTap
 * already ships; table/callout use the new nodes; task & note-link keep their
 * existing sub-panels.
 */
export const NOTE_SLASH_COMMANDS: NoteSlashCommand[] = [
  // Basic
  blockCmd('text', 'Plain paragraph', '\u{1F4C4}', 'paragraph', 'basic', ['paragraph', 'body', 'p']),
  blockCmd('h1', 'Big section heading', 'H1', 'h1', 'basic', ['heading', 'title', 'header']),
  blockCmd('h2', 'Medium section heading', 'H2', 'h2', 'basic', ['heading', 'subtitle']),
  blockCmd('h3', 'Small section heading', 'H3', 'h3', 'basic', ['heading', 'subheading']),
  // Lists
  blockCmd('bullet', 'Bulleted list', '•', 'bulletList', 'lists', ['ul', 'unordered', 'list']),
  blockCmd('numbered', 'Numbered list', '1.', 'orderedList', 'lists', ['ol', 'ordered', 'list']),
  blockCmd('todo', 'Checklist / to-do', '☑️', 'taskList', 'lists', ['task', 'checkbox', 'check', 'ck']),
  blockCmd('quote', 'Block quote', '❝', 'blockquote', 'lists', ['blockquote', 'citation']),
  // Blocks
  blockCmd('divider', 'Horizontal rule', '—', 'divider', 'blocks', ['hr', 'rule', 'separator', 'line']),
  blockCmd('code', 'Code block', '\u{1F4BB}', 'codeBlock', 'blocks', ['pre', 'snippet', 'fence']),
  blockCmd('callout', 'Highlighted callout', '\u{1F4A1}', 'callout', 'blocks', ['admonition', 'note', 'cl', 'warning', 'tip']),
  blockCmd('table', 'Insert a table', '\u{1F4CA}', 'table', 'blocks', ['grid', 'spreadsheet']),
  blockCmd('image', 'Upload or embed an image', '\u{1F5BC}️', 'image', 'blocks', ['img', 'picture', 'photo']),
  // Reference (inline — fire mid-sentence)
  {
    name: 'task',
    description: 'Insert a task reference',
    icon: '\u{1F4CB}',
    aliases: ['todo-ref', 'reference'],
    group: 'reference',
    commandClass: 'reference',
    subPanel: 'task-search',
  },
  {
    name: 'link',
    description: 'Link to another note',
    icon: '\u{1F517}',
    aliases: ['note', 'wikilink', 'ref'],
    group: 'reference',
    commandClass: 'reference',
    subPanel: 'note-link',
  },
];

export const GROUP_LABELS: Record<SlashCommandGroup, string> = {
  basic: 'Basic',
  lists: 'Lists',
  blocks: 'Blocks',
  reference: 'Reference',
};
