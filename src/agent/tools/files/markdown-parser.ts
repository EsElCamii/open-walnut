/**
 * Lightweight markdown parser for files_read parse=true.
 * Pure regex — no AST library needed.
 */
import yaml from 'js-yaml';
import type { ParseResult } from './types.js';

/** Task-ref regex: matches <task-ref id="..." label="..."/> */
const TASK_REF_RE = /<task-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;

/** Session-ref regex: matches <session-ref id="..." label="..."/> */
const SESSION_REF_RE = /<session-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;

/** Markdown link: [text](url) */
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/g;

/** Markdown heading: # ... through ###### ... */
const HEADING_RE = /^(#{1,6})\s+(.+)$/;

/** Todo item: - [ ] or - [x] or * [ ] or * [x] */
const TODO_RE = /^[-*]\s+\[([ xX])\]\s+(.+)$/;

/** Fenced code block: ```lang */
const CODE_FENCE_RE = /^```(\w*)$/;

/**
 * Parse markdown content into structured data.
 * Line numbers are 1-based (matching readFileWithMeta output).
 */
export function parseMarkdown(content: string): ParseResult {
  const lines = content.split('\n');
  const result: ParseResult = {
    headers: [],
    todos: [],
    task_refs: [],
    session_refs: [],
    links: [],
    code_blocks: [],
    word_count: 0,
    line_count: lines.length,
  };

  // ── Frontmatter ──
  if (lines[0] === '---') {
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        endIdx = i;
        break;
      }
    }
    if (endIdx > 0) {
      const fmText = lines.slice(1, endIdx).join('\n');
      try {
        const parsed = yaml.load(fmText);
        if (parsed && typeof parsed === 'object') {
          result.frontmatter = parsed as Record<string, unknown>;
        }
      } catch {
        // Invalid YAML — skip
      }
    }
  }

  // ── Line-by-line scan ──
  let inCodeBlock = false;
  let codeBlockStart = 0;
  let codeBlockLang = '';
  let wordCount = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1; // 1-based

    // Code fence toggle
    const fenceMatch = line.match(CODE_FENCE_RE);
    if (fenceMatch) {
      if (!inCodeBlock) {
        inCodeBlock = true;
        codeBlockStart = lineNum;
        codeBlockLang = fenceMatch[1] || '';
      } else {
        // End of code block
        result.code_blocks.push({
          language: codeBlockLang,
          line: codeBlockStart,
          length: lineNum - codeBlockStart + 1,
        });
        inCodeBlock = false;
      }
      continue;
    }

    // Skip content inside code blocks for other matchers
    if (inCodeBlock) continue;

    // Headings
    const headingMatch = line.match(HEADING_RE);
    if (headingMatch) {
      result.headers.push({
        level: headingMatch[1].length,
        text: headingMatch[2].trim(),
        line: lineNum,
      });
    }

    // Todos
    const todoMatch = line.trim().match(TODO_RE);
    if (todoMatch) {
      result.todos.push({
        text: todoMatch[2].trim(),
        checked: todoMatch[1] !== ' ',
        line: lineNum,
      });
    }

    // Task refs (multiple per line)
    let m: RegExpExecArray | null;
    // Global regexes retain lastIndex state — must reset before each per-line exec() loop.
    TASK_REF_RE.lastIndex = 0;
    while ((m = TASK_REF_RE.exec(line)) !== null) {
      result.task_refs.push({ id: m[1], label: m[2] || undefined, line: lineNum });
    }

    // Session refs (multiple per line)
    SESSION_REF_RE.lastIndex = 0;
    while ((m = SESSION_REF_RE.exec(line)) !== null) {
      result.session_refs.push({ id: m[1], label: m[2] || undefined, line: lineNum });
    }

    // Links (multiple per line)
    LINK_RE.lastIndex = 0;
    while ((m = LINK_RE.exec(line)) !== null) {
      result.links.push({ text: m[1], url: m[2], line: lineNum });
    }

    // Word count (rough: split on whitespace, filter empty)
    wordCount += line.split(/\s+/).filter(Boolean).length;
  }

  // Handle unclosed code block
  if (inCodeBlock) {
    result.code_blocks.push({
      language: codeBlockLang,
      line: codeBlockStart,
      length: lines.length - codeBlockStart + 1,
    });
  }

  result.word_count = wordCount;
  return result;
}
