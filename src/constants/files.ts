/**
 * File-related constants — binary extensions, size limits, image/PDF helpers.
 *
 * Ported from Claude Code's src/constants/files.ts and src/constants/apiLimits.ts
 * with Walnut-specific additions.
 */

// ── Binary extensions ──
// Full set from Claude Code (112 entries). Used by hasBinaryExtension() and grep/glob.

export const BINARY_EXTENSIONS = new Set([
  // Images
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.tiff', '.tif',
  // Videos
  '.mp4', '.mov', '.avi', '.mkv', '.webm', '.wmv', '.flv', '.m4v', '.mpeg', '.mpg',
  // Audio
  '.mp3', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.aiff', '.opus',
  // Archives
  '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.xz', '.z', '.tgz', '.iso',
  // Executables / binaries
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.a', '.obj', '.lib',
  '.app', '.msi', '.deb', '.rpm',
  // Documents (PDF is here; FileHandler excludes it at call site)
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.odt', '.ods', '.odp',
  // Fonts
  '.ttf', '.otf', '.woff', '.woff2', '.eot',
  // Bytecode / VM artifacts
  '.pyc', '.pyo', '.class', '.jar', '.war', '.ear', '.node', '.wasm', '.rlib',
  // Database files
  '.sqlite', '.sqlite3', '.db', '.mdb', '.idx',
  // Design / 3D
  '.psd', '.ai', '.eps', '.sketch', '.fig', '.xd', '.blend', '.3ds', '.max',
  // Flash
  '.swf', '.fla',
  // Lock / profiling data
  '.lockb', '.dat', '.data',
]);

/**
 * Check if a file path has a binary extension.
 */
export function hasBinaryExtension(filePath: string): boolean {
  const ext = filePath.slice(filePath.lastIndexOf('.')).toLowerCase();
  return BINARY_EXTENSIONS.has(ext);
}

// ── Binary content detection ──

const BINARY_CHECK_SIZE = 8192;

/**
 * Check if a buffer contains binary content by looking for null bytes
 * or a high proportion of non-printable characters.
 */
export function isBinaryContent(buffer: Buffer): boolean {
  const checkSize = Math.min(buffer.length, BINARY_CHECK_SIZE);
  let nonPrintable = 0;
  for (let i = 0; i < checkSize; i++) {
    const byte = buffer[i]!;
    if (byte === 0) return true;
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      nonPrintable++;
    }
  }
  return nonPrintable / checkSize > 0.1;
}

// ── Image extensions ──
// Subset of BINARY_EXTENSIONS that we can display inline via the vision API.

export const IMAGE_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp',
]);

export const MIME_MAP: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
};

/** Anthropic vision API supports only these mime types for inline images. */
export const VISION_MIME_TYPES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp',
]);

// ── PDF extensions ──

export const PDF_EXTENSIONS = new Set(['.pdf']);

export function isPDFExtension(ext: string): boolean {
  const normalized = ext.startsWith('.') ? ext : `.${ext}`;
  return PDF_EXTENSIONS.has(normalized.toLowerCase());
}

// ── Size limits ──

/** Max inline image size before compression (20 MB). */
export const MAX_INLINE_IMAGE_SIZE = 20 * 1024 * 1024;

/** Max raw PDF size for base64 path (20 MB → ~27 MB base64, within 32 MB API limit). */
export const PDF_TARGET_RAW_SIZE = 20 * 1024 * 1024;

/** Max PDF size for the page-extraction path (100 MB). */
export const PDF_MAX_EXTRACT_SIZE = 100 * 1024 * 1024;

/** Max pages the Read tool will extract per call. */
export const PDF_MAX_PAGES_PER_READ = 20;

/** Max output size for text read (256 KB). */
export const MAX_OUTPUT_SIZE = 256 * 1024;

/** Default max lines to read (aligned with Claude Code). */
export const DEFAULT_MAX_LINES = 2000;

/** Fast path threshold — files under this size are read entirely into memory. */
export const FAST_PATH_MAX_SIZE = 10 * 1024 * 1024;

/** Max file size for grep content search (1 MB per file). */
export const MAX_GREP_FILE_SIZE = 1 * 1024 * 1024;

// ── Blocked device paths ──
// Paths that should never be read (infinite streams, security risks).

export const BLOCKED_DEVICE_PATHS = new Set([
  '/dev/stdin',
  '/dev/stdout',
  '/dev/stderr',
  '/dev/null',
  '/dev/zero',
  '/dev/random',
  '/dev/urandom',
  '/proc/kcore',
]);

export function isBlockedDevicePath(filePath: string): boolean {
  return BLOCKED_DEVICE_PATHS.has(filePath);
}

// ── Skip dirs for glob/grep ──

export const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.hg',
  '.svn',
  'dist',
  '.next',
  '.cache',
  '__pycache__',
  '.tox',
  '.mypy_cache',
  '.pytest_cache',
  'coverage',
  '.nyc_output',
  '.turbo',
]);
