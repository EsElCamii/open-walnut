/**
 * Shared types for the unified files_* tool group.
 *
 * Three handler types resolve sources to file operations:
 *   MemoryHandler  — memory/global, memory/project/*, memory/daily/*
 *   NotesHandler   — notes/global, notes/{name}
 *   FileHandler    — /absolute/path
 */
import type { ToolResultContent } from '../../tools.js';

// ── Source resolution ──

export type SourceType = 'memory' | 'notes' | 'file' | 'repos';

export interface ResolvedSource {
  type: SourceType;
  /** Absolute path on disk. */
  filePath: string;
  /** Original source URI (for error messages). */
  source: string;
  /** Sub-type hint for handler dispatch. */
  variant?: string;
  /** Extra parsed info (e.g. project_path, date). */
  meta?: Record<string, string>;
}

// ── Read result ──

export interface FilesReadResult {
  content: string;
  content_hash: string;
  total_lines: number;
  showing: string;
  /** Structured parse output when parse=true. */
  parsed?: ParseResult;
  /** Internal: file mtime for readFileState tracking. Stripped before returning to model. */
  _mtimeMs?: number;
  /** Internal: whether this is a partial view (offset/limit applied). */
  _isPartialView?: boolean;
}

// ── Write / edit results ──

export interface FilesWriteResult {
  status: string;
  content_hash: string;
  /** Extra fields from append (e.g. written_to). */
  [key: string]: unknown;
}

export interface FilesEditResult {
  status: string;
  replacements: number;
  content_hash: string;
}

// ── List result ──

export interface FilesListItem {
  source: string;
  name?: string;
  description?: string;
  /** For directory listings: 'file' or 'dir'. */
  type?: string;
  size?: number;
  modified?: string;
}

// ── Parse output ──

export interface ParseResult {
  frontmatter?: Record<string, unknown>;
  headers: { level: number; text: string; line: number }[];
  todos: { text: string; checked: boolean; line: number }[];
  task_refs: { id: string; label?: string; line: number }[];
  session_refs: { id: string; label?: string; line: number }[];
  links: { text: string; url: string; line: number }[];
  code_blocks: { language: string; line: number; length: number }[];
  word_count: number;
  line_count: number;
}

// ── Handler interface ──

export interface FileHandler {
  read(resolved: ResolvedSource, opts?: { offset?: number; limit?: number; pages?: string }): Promise<FilesReadResult | ToolResultContent>;
  write(resolved: ResolvedSource, content: string, opts?: { mode?: 'overwrite' | 'append'; contentHash?: string }): Promise<FilesWriteResult>;
  edit(resolved: ResolvedSource, oldContent: string, newContent: string, opts?: { contentHash?: string; replaceAll?: boolean }): Promise<FilesEditResult>;
  list(resolved: ResolvedSource): Promise<FilesListItem[]>;
}
