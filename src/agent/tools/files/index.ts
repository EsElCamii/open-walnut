/**
 * Unified files tool group — barrel exports.
 */
export { resolveSource } from './resolver.js';
export { parseMarkdown } from './markdown-parser.js';
export { memoryHandler } from './memory-handler.js';
export { notesHandler } from './notes-handler.js';
export { fileHandler } from './file-handler.js';
export type {
  ResolvedSource,
  FilesReadResult,
  FilesWriteResult,
  FilesEditResult,
  FilesListItem,
  ParseResult,
  FileHandler,
} from './types.js';
