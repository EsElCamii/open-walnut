import { marked } from 'marked';
import DOMPurify from 'dompurify';

/** Task-ref regex: matches <task-ref id="..." label="..."/> or <task-ref id="..."/> */
const TASK_REF_RE = /<task-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;
/** Session-ref regex: matches <session-ref id="..." label="..."/> or <session-ref id="..."/> */
const SESSION_REF_RE = /<session-ref\s+id="([^"]*)"(?:\s+label="([^"]*)")?\s*\/?>/g;

/**
 * Convert entity reference XML tags to clickable HTML anchors.
 * Handles both labeled (resolved) and unlabeled (streaming/unresolved) variants.
 */
export function entityRefsToHtml(text: string): string {
  let result = text;
  result = result.replace(TASK_REF_RE, (_match, id: string, label?: string) => {
    const display = label || id;
    const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="/tasks/${id}" class="task-link" data-task-id="${id}">${escaped}</a>`;
  });
  result = result.replace(SESSION_REF_RE, (_match, id: string, label?: string) => {
    const display = label || id;
    const escaped = display.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<a href="/sessions?id=${id}" class="session-link" data-session-id="${id}">${escaped}</a>`;
  });
  return result;
}

/**
 * Convert entity reference XML tags to markdown links.
 * Used by NotesEditor to preprocess pasted/loaded content containing raw XML refs.
 * <task-ref id="X" label="Y"/> → [Y](/tasks/X)
 * <session-ref id="X" label="Y"/> → [Y](/sessions?id=X)
 */
export function entityRefsToMarkdownLinks(text: string): string {
  let result = text;
  result = result.replace(TASK_REF_RE, (_match, id: string, label?: string) => {
    const display = (label || id).replace(/[\[\]]/g, '\\$&');
    return `[${display}](/tasks/${id})`;
  });
  result = result.replace(SESSION_REF_RE, (_match, id: string, label?: string) => {
    const display = (label || id).replace(/[\[\]]/g, '\\$&');
    return `[${display}](/sessions?id=${id})`;
  });
  return result;
}

/** DOMPurify attributes preserved for entity ref, image, and file link rendering */
const SANITIZE_ATTRS = ['data-task-id', 'data-session-id', 'data-lightbox-src', 'data-file-path', 'data-file-line', 'loading'];

// ── JSON ID pill injection for tool call INPUT/RESULT areas ──

/** Regex for task-ID-bearing keys in JSON: "task_id", "taskId", "parent_task_id" */
const JSON_TASK_ID_RE = /(&quot;(?:task_id|taskId|parent_task_id)&quot;:\s*&quot;)([a-z0-9]{7,10}-[a-f0-9]{4})(&quot;)/g;

/** Regex for session-ID-bearing keys in JSON */
const JSON_SESSION_ID_RE = /(&quot;(?:session_id|sessionId|from_plan|plan_session|exec_session|plan_session_id|exec_session_id)&quot;:\s*&quot;)([^&]+)(&quot;)/g;

/** Regex for bare "id" key when value matches task ID format */
const JSON_BARE_ID_RE = /(&quot;id&quot;:\s*&quot;)([a-z0-9]{7,10}-[a-f0-9]{4})(&quot;)/g;

/**
 * Inject clickable <a> pill tags into HTML-escaped JSON text for task_id and session_id values.
 * Expects the input to be already HTML-escaped (& → &amp;, < → &lt;, " → &quot;).
 */
export function injectJsonIdLinks(escapedText: string): string {
  let result = escapedText;

  // Task ID keys
  result = result.replace(JSON_TASK_ID_RE, (_m, prefix, id, suffix) => {
    return `${prefix}<a class="task-link" data-task-id="${id}" href="/tasks/${id}">${id}</a>${suffix}`;
  });

  // Session ID keys
  result = result.replace(JSON_SESSION_ID_RE, (_m, prefix, id, suffix) => {
    const display = id.length > 12 ? id.slice(0, 12) + '\u2026' : id;
    return `${prefix}<a class="session-link" data-session-id="${id}" href="/sessions?id=${id}" title="${id}">${display}</a>${suffix}`;
  });

  // Bare "id" key (only task ID format)
  result = result.replace(JSON_BARE_ID_RE, (_m, prefix, id, suffix) => {
    return `${prefix}<a class="task-link" data-task-id="${id}" href="/tasks/${id}">${id}</a>${suffix}`;
  });

  // file_path / path values — make clickable
  // Matches: "file_path": "/abs/path/to/file.ts" or "path": "/abs/path"
  result = result.replace(
    /(&quot;(?:file_path|path)&quot;:\s*&quot;)(\/[^&]+?)(&quot;)/g,
    (_m, prefix, filePath, suffix) => {
      return `${prefix}<a class="file-link" data-file-path="${filePath}" href="#">${filePath}</a>${suffix}`;
    },
  );

  return result;
}

/**
 * Render tool result text with both entity-ref XML support AND raw JSON ID pill injection.
 * Pipeline: entityRefsToHtml → injectJsonIdLinks (on the escaped portions) → marked → DOMPurify.
 */
export function renderToolResultWithRefs(text: string): string {
  try {
    // Step 1: Convert <task-ref>/<session-ref> XML to <a> tags
    const withEntityRefs = entityRefsToHtml(text);
    // Step 2: Run marked to get HTML
    const raw = marked.parse(withEntityRefs);
    const html = typeof raw === 'string' ? raw : '';
    // Step 3: Inject JSON ID pills into HTML-escaped JSON values
    // The marked parser will have HTML-escaped the JSON quotes as &quot;
    const withPills = injectJsonIdLinks(html);
    // Step 4: Sanitize
    return DOMPurify.sanitize(withPills, { ADD_ATTR: SANITIZE_ATTRS });
  } catch {
    return DOMPurify.sanitize(text);
  }
}

// ── File path detection & linkification ──

/** Image extensions to exclude from file-path linkification */
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'ico', 'bmp', 'tiff']);

/** Common code/text extensions that indicate a real file path */
const CODE_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'json', 'yaml', 'yml', 'toml',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'cpp', 'h', 'hpp',
  'css', 'scss', 'less', 'html', 'xml', 'sql', 'graphql', 'proto',
  'sh', 'bash', 'zsh', 'fish', 'ps1', 'bat', 'cmd',
  'md', 'mdx', 'txt', 'log', 'csv', 'tsv', 'env', 'conf', 'cfg', 'ini',
  'lock', 'gitignore', 'dockerignore', 'editorconfig',
  'dockerfile', 'makefile',
]);

/**
 * Convert file paths in text to clickable <a class="file-link"> elements.
 * Runs as a preprocessing step before marked.parse().
 *
 * Two-pass approach:
 * 1. Absolute paths: /dir/dir/file.ext (with optional :line suffix)
 * 2. Relative paths with extension: dir/file.ext (needs sessionCwd to resolve)
 *
 * Exclusions: URLs, image paths, code fences, already-linked text.
 */
export function filePathsToHtml(text: string, sessionCwd?: string): string {
  // Track code fence regions to skip
  const fenceRanges: [number, number][] = [];
  const fenceRe = /```[\s\S]*?```|`[^`\n]+`/g;
  let fm: RegExpExecArray | null;
  while ((fm = fenceRe.exec(text)) !== null) {
    fenceRanges.push([fm.index, fm.index + fm[0].length]);
  }

  function isInFence(idx: number): boolean {
    return fenceRanges.some(([start, end]) => idx >= start && idx < end);
  }

  // Also skip if preceded by :// (URL), or if inside <a> tag
  function shouldSkip(matchIdx: number, matchStr: string): boolean {
    if (isInFence(matchIdx)) return true;
    // Check for URL context (://path)
    if (matchIdx >= 3 && text.slice(matchIdx - 3, matchIdx).includes('://')) return true;
    // Check for markdown image ![...](path)
    if (matchIdx >= 2 && text[matchIdx - 1] === '(' && text.slice(0, matchIdx).lastIndexOf('![') > text.slice(0, matchIdx).lastIndexOf(']')) return true;
    return false;
  }

  let result = text;
  const replacements: { start: number; end: number; replacement: string }[] = [];

  // Pass 1: Absolute paths — /dir/file.ext or /dir/file.ext:42
  // Negative lookbehind: leading `/` must NOT be preceded by a word char or another `/`.
  // This prevents matching mid-path substrings like `/providers/foo.ts` from `src/providers/foo.ts`.
  const absRe = /(?<![\/\w])(\/(?:[\w@.+-]+\/)+[\w@.+-]+\.[\w]+)(?::(\d+))?/g;
  let m: RegExpExecArray | null;
  while ((m = absRe.exec(text)) !== null) {
    const fullMatch = m[0];
    const filePath = m[1];
    const lineNum = m[2];

    if (shouldSkip(m.index, fullMatch)) continue;

    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (IMAGE_EXTENSIONS.has(ext)) continue;

    const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
    const display = lineNum ? `${filePath}:${lineNum}` : filePath;
    const replacement = `<a class="file-link" data-file-path="${filePath}"${lineAttr} href="#">${display}</a>`;
    replacements.push({ start: m.index, end: m.index + fullMatch.length, replacement });
  }

  // Pass 2: Relative paths with extension — dir/file.ext or ./file.ext:42
  // Only linkify if sessionCwd is available (needed to resolve absolute path)
  if (sessionCwd) {
    const relRe = /(?:^|[\s"'`(])((\.\/|[\w@][\w@.+-]*\/)+[\w@.+-]+\.(\w+))(?::(\d+))?/gm;
    while ((m = relRe.exec(text)) !== null) {
      // m[1] = the path, m[3] = extension, m[4] = line number
      const pathPart = m[1];
      const ext = m[3]?.toLowerCase();
      const lineNum = m[4];

      if (!ext || IMAGE_EXTENSIONS.has(ext)) continue;
      if (!CODE_EXTENSIONS.has(ext)) continue;

      // Calculate the actual match position (m[1] may start after whitespace)
      const pathStart = m.index + m[0].indexOf(pathPart);
      const fullEnd = lineNum ? pathStart + pathPart.length + 1 + lineNum.length : pathStart + pathPart.length;

      if (shouldSkip(pathStart, pathPart)) continue;

      // Skip if this overlaps with an already-found absolute path
      const overlaps = replacements.some(r => pathStart < r.end && fullEnd > r.start);
      if (overlaps) continue;

      const absPath = sessionCwd.replace(/\/$/, '') + '/' + pathPart.replace(/^\.\//, '');
      const lineAttr = lineNum ? ` data-file-line="${lineNum}"` : '';
      const display = lineNum ? `${pathPart}:${lineNum}` : pathPart;
      const replacement = `<a class="file-link" data-file-path="${absPath}"${lineAttr} href="#">${display}</a>`;
      replacements.push({ start: pathStart, end: fullEnd, replacement });
    }
  }

  // Apply replacements in reverse order to preserve indices
  replacements.sort((a, b) => b.start - a.start);
  for (const r of replacements) {
    result = result.slice(0, r.start) + r.replacement + result.slice(r.end);
  }

  return result;
}

/**
 * Render markdown text with entity ref support and file path linkification.
 * Preprocesses <task-ref> and <session-ref> XML tags into clickable HTML anchors,
 * converts file paths to clickable links,
 * then runs marked.parse() + DOMPurify.sanitize().
 */
export function renderMarkdownWithRefs(text: string, sessionCwd?: string): string {
  try {
    let preprocessed = entityRefsToHtml(text);
    preprocessed = filePathsToHtml(preprocessed, sessionCwd);
    const raw = marked.parse(preprocessed);
    return typeof raw === 'string' ? DOMPurify.sanitize(raw, { ADD_ATTR: SANITIZE_ATTRS }) : '';
  } catch {
    return DOMPurify.sanitize(text);
  }
}

// ── Shared constants for tool call markdown field expansion (Phase 2) ──

/** Input field keys that should never get markdown expansion (IDs, paths, etc.) */
export const MARKDOWN_EXCLUDED_INPUT_KEYS = new Set([
  'task_id', 'taskId', 'session_id', 'sessionId', 'from_plan',
  'id', 'cwd', 'file_path', 'working_directory',
]);

/** Minimum string length to qualify for markdown expansion */
export const MARKDOWN_FIELD_MIN_LENGTH = 200;

/**
 * Extract long multiline string fields from tool input and render as markdown.
 * Used by ToolCallSection (ChatMessage) and GenericToolCall (SessionMessage).
 */
export function extractMarkdownFields(
  input: Record<string, unknown>,
): { key: string; html: string }[] {
  return Object.entries(input)
    .filter(([k, v]) =>
      typeof v === 'string' &&
      (v as string).includes('\n') &&
      (v as string).length > MARKDOWN_FIELD_MIN_LENGTH &&
      !MARKDOWN_EXCLUDED_INPUT_KEYS.has(k),
    )
    .map(([k, v]) => ({ key: k, html: renderMarkdownWithRefs(v as string) }));
}

// ── Tool result image detection & rendering ──

/** Image file extension pattern */
const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp)$/i;

/** Match absolute image file paths in text (allows spaces/hyphens in path segments) */
const IMAGE_PATH_IN_TEXT_RE = /(\/(?:[\w. -]+\/)+[\w. -]+\.(?:png|jpe?g|gif|webp))/gi;

/** Match relative image file paths like "screenshot.png" or "subdir/file.png".
 *  Boundaries include backtick — Claude Code commonly wraps filenames in backticks. */
const RELATIVE_IMAGE_PATH_RE = /(?:^|[\s"'`=:(])(([\w][\w.-]*\/)*[\w][\w.-]*\.(?:png|jpe?g|gif|webp))(?=[\s"'`),;\]}]|$)/gi;

/**
 * Extract base64 images from Anthropic content-block JSON format.
 * Handles both array and single-object forms:
 *   [{"type":"image","source":{"type":"base64","media_type":"image/png","data":"iVBOR..."}}]
 *   {"type":"image","source":{"type":"base64","data":"..."}}
 */
export function extractContentBlockImages(result: string): { imageSrcs: string[]; textParts: string[] } | null {
  const trimmed = result.trimStart();
  if ((trimmed[0] !== '[' && trimmed[0] !== '{') || !result.includes('"base64"')) return null;

  try {
    const parsed = JSON.parse(result);
    const blocks = Array.isArray(parsed) ? parsed : [parsed];
    const imageSrcs: string[] = [];
    const textParts: string[] = [];

    for (const block of blocks) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'image') {
        const source = b.source as Record<string, unknown> | undefined;
        if (source?.type === 'base64' && typeof source.data === 'string') {
          const mt = typeof source.media_type === 'string' ? source.media_type : 'image/png';
          imageSrcs.push(`data:${mt};base64,${source.data}`);
        }
      } else if (b.type === 'text' && typeof b.text === 'string') {
        textParts.push(b.text);
      }
    }

    return imageSrcs.length > 0 ? { imageSrcs, textParts } : null;
  } catch {
    return null;
  }
}

/** Find image file paths in text — both absolute (/path/to/img.png) and relative (img.png) */
export function findImagePaths(text: string): string[] {
  const paths: string[] = [];
  // Pass 1: absolute paths
  let re = new RegExp(IMAGE_PATH_IN_TEXT_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) paths.push(m[1]);
  // Pass 2: relative paths (skip any already captured as absolute)
  const absSet = new Set(paths);
  re = new RegExp(RELATIVE_IMAGE_PATH_RE.source, 'gi');
  while ((m = re.exec(text)) !== null) {
    const p = m[1];
    if (!p.startsWith('/') && !absSet.has(p)) paths.push(p);
  }
  return [...new Set(paths)];
}

/** Check if a file path looks like an image file */
export function isImageFilePath(p: string): boolean {
  return IMAGE_EXT_RE.test(p);
}

/** Resolve an image path: absolute paths pass through, relative paths get cwd prepended.
 *  Returns null if a relative path can't be resolved (no cwd available). */
export function resolveImagePath(path: string, cwd?: string): string | null {
  if (path.startsWith('/')) return path;
  if (cwd) return `${cwd.replace(/\/$/, '')}/${path}`;
  return null;
}

/**
 * Isolated DOMPurify instance for note rendering.
 * Hooks are added once at module init — no global mutations, no race conditions.
 */
const notePurify = DOMPurify();
notePurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

/**
 * Render a note string as sanitized HTML with markdown support.
 * All <a> links open in a new tab with noopener/noreferrer.
 */
export function renderNoteMarkdown(text: string): string {
  let html: string;
  try {
    const raw = marked.parse(text, { breaks: true, gfm: true });
    html = typeof raw === 'string' ? raw : '';
  } catch {
    // Fallback: escape and return raw text in a <p> tag
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<p>${escaped}</p>`;
  }

  return notePurify.sanitize(html, { ADD_ATTR: ['target'] });
}
