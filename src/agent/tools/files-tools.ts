/**
 * Unified files_* tool group — 6 tools for CRUDL + search on any content source.
 *
 * files_read  — read any source with optional parse
 * files_write — write/append to any source
 * files_edit  — edit by exact string replacement
 * files_list  — list contents under a source prefix
 * files_glob  — find files by glob pattern
 * files_grep  — search file contents by regex
 */
import type { ToolDefinition, ToolResultContent } from '../tools.js';
import {
  resolveSource,
  parseMarkdown,
  memoryHandler,
  notesHandler,
  reposHandler,
  fileHandler,
  filesGlob,
  filesGrep,
} from './files/index.js';
import type { FileHandler, FilesReadResult, GrepOptions } from './files/index.js';
import {
  StaleHashError,
  ContentNotFoundError,
  AmbiguousMatchError,
} from '../../utils/file-ops.js';

function json(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

/** Get the handler for a resolved source. */
function getHandler(type: string): FileHandler {
  switch (type) {
    case 'memory': return memoryHandler;
    case 'notes': return notesHandler;
    case 'repos': return reposHandler;
    case 'file': return fileHandler;
    default: throw new Error(`Unknown source type: ${type}`);
  }
}

/** Format error messages consistently. */
function formatError(err: unknown, source: string): string {
  if (err instanceof StaleHashError) {
    return `Error: ${err.message}`;
  }
  if (err instanceof ContentNotFoundError) {
    return `Error: old_content not found in "${source}". Make sure the string matches exactly (including whitespace and indentation). Use files_read first to see current content.`;
  }
  if (err instanceof AmbiguousMatchError) {
    return `Error: ${err.message}`;
  }
  const code = (err as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return `Error: Source not found: "${source}". File does not exist.`;
  }
  if (code === 'EACCES') {
    return `Error: Permission denied: "${source}".`;
  }
  if (code === 'EISDIR') {
    return `Error: Source is a directory, not a file: "${source}". Use files_list instead.`;
  }
  return `Error: ${err instanceof Error ? err.message : String(err)}`;
}

// ── files_read ──

export const filesReadTool: ToolDefinition = {
  name: 'files_read',
  description: `Read any content source. Returns line-numbered text + content_hash. Images return inline.

Special sources (use these URIs instead of raw file paths):
  notes/global           — The Notes panel on the home page: user's personal scratchpad
                           with todos, checklists, task-refs, and links (WYSIWYG markdown).
  notes/{name}           — Named note document (e.g. notes/recipes, notes/reading-list).
  memory/global          — Agent's curated knowledge & user preferences (MEMORY.md).
                           Updated by the agent as it learns across sessions.
  memory/project/{path}  — Per-project work log and accumulated context
                           (e.g. memory/project/work/api, memory/project/passion/walnut).
  memory/daily           — Today's activity log (timestamped entries from all sessions).
  memory/daily/YYYY-MM-DD — Specific day's log (e.g. memory/daily/2026-03-25).
  repos/                 — List all registered repositories (name, description, hosts).
  repos/{name}           — Read repository details (YAML: hosts, tech stack, architecture, commands).
  /absolute/path         — Any file on disk. Images (PNG/JPEG/GIF/WebP) return inline.

Set parse=true to also return structured extraction (headers, todos, task-refs, links).`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      offset: {
        type: 'number',
        description: '1-based start line.',
      },
      limit: {
        type: 'number',
        description: 'Max lines to return.',
      },
      parse: {
        type: 'boolean',
        description: 'Also return structured parse result (headers, todos, task-refs, links).',
      },
    },
    required: ['source'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    if (!source) return 'Error: source is required.';

    try {
      const resolved = resolveSource(source);
      const handler = getHandler(resolved.type);
      const result = await handler.read(resolved, {
        offset: params.offset as number | undefined,
        limit: params.limit as number | undefined,
      });

      // If handler returned raw content (e.g. image blocks), pass through
      if (typeof result === 'string' || Array.isArray(result)) {
        return result;
      }

      const readResult = result as FilesReadResult;

      // Optionally parse
      if (params.parse) {
        // We need the raw (un-numbered) content for parsing.
        // Reconstruct from line-numbered output by stripping line numbers.
        const rawLines = readResult.content.split('\n').map((line) => {
          // Line format: "    42\tcontent..." — strip the 6-char number + tab prefix
          const tabIdx = line.indexOf('\t');
          return tabIdx >= 0 ? line.slice(tabIdx + 1) : line;
        });
        const rawContent = rawLines.join('\n');
        readResult.parsed = parseMarkdown(rawContent);
      }

      return json(readResult);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── files_write ──

export const filesWriteTool: ToolDefinition = {
  name: 'files_write',
  description: `Write or append content to any source.
Mode 'overwrite' replaces entire content (default). Mode 'append' adds to end.
For memory sources: append auto-prepends timestamp heading.
content_hash (from files_read) required for overwrite on memory/notes sources — prevents stale writes.
For file sources: content_hash is optional but recommended for safety.

Sources: notes/global, notes/{name}, memory/global, memory/project/{path},
memory/daily[/YYYY-MM-DD], repos/{name}, /absolute/path — see files_read for full descriptions.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      content: {
        type: 'string',
        description: 'The content to write or append.',
      },
      mode: {
        type: 'string',
        enum: ['overwrite', 'append'],
        description: 'Write mode. Default: overwrite.',
      },
      content_hash: {
        type: 'string',
        description: 'From files_read. Required for overwrite on memory/notes sources.',
      },
    },
    required: ['source', 'content'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    const content = params.content as string;
    if (!source) return 'Error: source is required.';
    if (content == null) return 'Error: content is required.';

    try {
      const resolved = resolveSource(source);
      const handler = getHandler(resolved.type);
      const result = await handler.write(resolved, content, {
        mode: (params.mode as 'overwrite' | 'append') ?? 'overwrite',
        contentHash: params.content_hash as string | undefined,
      });
      return json(result);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── files_edit ──

export const filesEditTool: ToolDefinition = {
  name: 'files_edit',
  description: `Edit by exact string replacement in any source.
content_hash (from files_read) required for memory/notes sources — prevents stale edits.
For file sources: content_hash is optional but recommended.

Sources: notes/global, notes/{name}, memory/global, memory/project/{path},
memory/daily[/YYYY-MM-DD], repos/{name}, /absolute/path — see files_read for full descriptions.`,
  input_schema: {
    type: 'object',
    properties: {
      source: {
        type: 'string',
        description: 'Content source URI.',
      },
      old_content: {
        type: 'string',
        description: 'Exact text to find.',
      },
      new_content: {
        type: 'string',
        description: 'Replacement text. Empty string to delete matched text.',
      },
      content_hash: {
        type: 'string',
        description: 'From files_read. Required for memory/notes sources.',
      },
      replace_all: {
        type: 'boolean',
        description: 'Replace all occurrences instead of requiring a unique match. Default: false.',
      },
    },
    required: ['source', 'old_content'],
  },

  async execute(params): Promise<ToolResultContent> {
    const source = params.source as string;
    const oldContent = params.old_content as string;
    const newContent = (params.new_content as string) ?? '';
    if (!source) return 'Error: source is required.';
    if (!oldContent) return 'Error: old_content is required.';

    try {
      const resolved = resolveSource(source);
      const handler = getHandler(resolved.type);
      const result = await handler.edit(resolved, oldContent, newContent, {
        contentHash: params.content_hash as string | undefined,
        replaceAll: (params.replace_all as boolean) ?? false,
      });
      return json(result);
    } catch (err) {
      return formatError(err, source);
    }
  },
};

// ── files_list ──

export const filesListTool: ToolDefinition = {
  name: 'files_list',
  description: `List available content under a source prefix.
  "notes"          → all note documents (global + named notes)
  "memory/project" → all project memories with names & descriptions
  "memory/daily"   → all daily log dates (most recent first)
  "repos"          → all registered repositories (name, description, hosts)
  "/path/to/dir"   → directory listing of files on disk`,
  input_schema: {
    type: 'object',
    properties: {
      prefix: {
        type: 'string',
        description: 'Source prefix to list.',
      },
    },
    required: ['prefix'],
  },

  async execute(params): Promise<ToolResultContent> {
    const prefix = params.prefix as string;
    if (!prefix) return 'Error: prefix is required.';

    try {
      const resolved = resolveSource(prefix);
      const handler = getHandler(resolved.type);
      const items = await handler.list(resolved);

      if (items.length === 0) {
        return `No items found under "${prefix}".`;
      }
      return json(items);
    } catch (err) {
      return formatError(err, prefix);
    }
  },
};

// ── files_glob ──

export const filesGlobTool: ToolDefinition = {
  name: 'files_glob',
  description: `Find files by glob pattern. Returns matching paths sorted by modification time (most recent first).
Pattern syntax: * matches any chars in one segment, ** matches across segments,
{a,b} matches either, [abc] matches character class.
Example: files_glob(pattern="**/*.ts", path="/project/src")`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Glob pattern (e.g. "**/*.ts", "src/**/index.*").',
      },
      path: {
        type: 'string',
        description: 'Base directory to search in. Default: cwd.',
      },
    },
    required: ['pattern'],
  },

  async execute(params): Promise<ToolResultContent> {
    const pattern = params.pattern as string;
    if (!pattern) return 'Error: pattern is required.';

    try {
      const result = filesGlob(pattern, params.path as string | undefined);
      return json(result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ── files_grep ──

export const filesGrepTool: ToolDefinition = {
  name: 'files_grep',
  description: `Search file contents by regex. Returns matching lines with optional context.
Output modes: "content" (lines + context), "files" (paths only, default), "count" (per-file counts).
Use glob or type to filter files. type maps common names (js, ts, py, go, rust, etc.) to extensions.`,
  input_schema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Regex pattern to search for.',
      },
      path: {
        type: 'string',
        description: 'File or directory to search. Default: cwd.',
      },
      glob: {
        type: 'string',
        description: 'Glob to filter files (e.g. "*.ts", "**/*.{ts,tsx}"). Mutually exclusive with type.',
      },
      type: {
        type: 'string',
        description: 'File type filter (e.g. "js", "ts", "py", "go", "rust", "java", "c", "cpp", "css", "html", "json", "yaml", "md", "sh"). Mutually exclusive with glob.',
      },
      output_mode: {
        type: 'string',
        enum: ['content', 'files', 'count'],
        description: 'Default: "files".',
      },
      context: {
        type: 'number',
        description: 'Symmetric context lines before AND after each match (-C).',
      },
      context_before: {
        type: 'number',
        description: 'Lines of context before each match (-B). Overrides context for before direction.',
      },
      context_after: {
        type: 'number',
        description: 'Lines of context after each match (-A). Overrides context for after direction.',
      },
      case_insensitive: {
        type: 'boolean',
        description: 'Case insensitive matching. Default: false.',
      },
      max_results: {
        type: 'number',
        description: 'Max entries to return. Default: 50.',
      },
      offset: {
        type: 'number',
        description: 'Skip first N entries before collecting results.',
      },
      multiline: {
        type: 'boolean',
        description: 'Enable multiline mode: . matches newlines, patterns can span lines. Default: false.',
      },
    },
    required: ['pattern'],
  },

  async execute(params): Promise<ToolResultContent> {
    const pattern = params.pattern as string;
    if (!pattern) return 'Error: pattern is required.';

    try {
      const opts: GrepOptions = {
        path: params.path as string | undefined,
        glob: params.glob as string | undefined,
        type: params.type as string | undefined,
        output_mode: params.output_mode as GrepOptions['output_mode'],
        context: params.context as number | undefined,
        context_before: params.context_before as number | undefined,
        context_after: params.context_after as number | undefined,
        case_insensitive: params.case_insensitive as boolean | undefined,
        max_results: params.max_results as number | undefined,
        offset: params.offset as number | undefined,
        multiline: params.multiline as boolean | undefined,
      };
      const result = filesGrep(pattern, opts);
      return json(result);
    } catch (err) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

/** All files_* tools for registration. */
export const filesTools: ToolDefinition[] = [
  filesReadTool,
  filesWriteTool,
  filesEditTool,
  filesListTool,
  filesGlobTool,
  filesGrepTool,
];
