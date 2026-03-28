/**
 * ReposHandler — handles repos/ and repos/{name} sources.
 *
 * repos/       → list all registered repositories
 * repos/{name} → read/write/edit a single repository YAML file
 *
 * Storage: ~/.open-walnut/repositories/{name}.yaml
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { REPOSITORIES_DIR } from '../../../constants.js';
import {
  readFileWithMeta,
  writeFileChecked,
  editFileContent,
  computeContentHash,
} from '../../../utils/file-ops.js';
import type { FileHandler, ResolvedSource, FilesReadResult, FilesWriteResult, FilesEditResult, FilesListItem } from './types.js';

/**
 * Parse the first few lines of a YAML file to extract name + description.
 * Avoids pulling in a full YAML parser for this lightweight operation.
 */
function parseYamlHeader(content: string): { name?: string; description?: string; hosts: string[] } {
  const lines = content.split('\n');
  let name: string | undefined;
  let description: string | undefined;
  const hosts: string[] = [];
  let inHosts = false;

  for (const line of lines) {
    if (line.startsWith('name:')) {
      name = line.slice('name:'.length).trim().replace(/^["']|["']$/g, '');
      inHosts = false;
    } else if (line.startsWith('description:')) {
      description = line.slice('description:'.length).trim().replace(/^["']|["']$/g, '');
      if (description === '|' || description === '>') {
        // Multi-line description — grab next non-empty indented line
        const idx = lines.indexOf(line);
        for (let i = idx + 1; i < lines.length; i++) {
          const nextLine = lines[i].trim();
          if (nextLine && lines[i].startsWith(' ')) {
            description = nextLine;
            break;
          }
          if (!lines[i].startsWith(' ') && nextLine) break;
        }
      }
      inHosts = false;
    } else if (line.startsWith('hosts:')) {
      inHosts = true;
    } else if (inHosts) {
      // Host entries are indented keys like "  local:" or "  cloud-desktop:"
      const hostMatch = line.match(/^  (\S+):$/);
      if (hostMatch) {
        hosts.push(hostMatch[1]);
      } else if (!line.startsWith(' ')) {
        inHosts = false;
      }
    }
  }

  return { name, description, hosts };
}

export interface RepoSummary {
  name: string;
  description: string;
  hosts: string[];
}

/**
 * List all repo summaries (sync). Used by buildMemoryContext() for agent system prompt.
 */
export function listRepoSummaries(): RepoSummary[] {
  try {
    if (!fs.existsSync(REPOSITORIES_DIR)) return [];
    const files = fs.readdirSync(REPOSITORIES_DIR)
      .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
      .sort();

    const summaries: RepoSummary[] = [];
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(REPOSITORIES_DIR, f), 'utf-8');
        const header = parseYamlHeader(content);
        summaries.push({
          name: header.name || f.replace(/\.ya?ml$/, ''),
          description: header.description || '(no description)',
          hosts: header.hosts,
        });
      } catch {
        // Skip unreadable files
      }
    }
    return summaries;
  } catch {
    return [];
  }
}

export const reposHandler: FileHandler = {
  async read(resolved, opts) {
    const meta = await readFileWithMeta(resolved.filePath, opts);
    return {
      content: meta.content,
      content_hash: meta.contentHash,
      total_lines: meta.totalLines,
      showing: meta.showing,
    };
  },

  async write(resolved, content, opts) {
    const mode = opts?.mode ?? 'overwrite';

    if (mode === 'append') {
      await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
      await fsp.appendFile(resolved.filePath, content, 'utf-8');
      const updated = await fsp.readFile(resolved.filePath, 'utf-8');
      return {
        status: 'appended',
        content_hash: computeContentHash(updated),
      };
    }

    // Allow first-write without hash (creating a new repo)
    if (!opts?.contentHash) {
      try {
        await fsp.access(resolved.filePath);
        throw new Error('content_hash is required for overwrite on existing repos. Read first with files_read.');
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }

    await fsp.mkdir(path.dirname(resolved.filePath), { recursive: true });
    const result = await writeFileChecked(resolved.filePath, content, {
      expectedHash: opts?.contentHash,
    });
    return { status: opts?.contentHash ? 'updated' : 'created', content_hash: result.contentHash };
  },

  async edit(resolved, oldContent, newContent, opts) {
    if (!opts?.contentHash) {
      throw new Error('content_hash is required for editing repos. Read first with files_read.');
    }
    if (!oldContent) {
      throw new Error('old_content cannot be empty.');
    }

    const result = await editFileContent(resolved.filePath, oldContent, newContent, {
      expectedHash: opts.contentHash,
      replaceAll: opts?.replaceAll,
    });
    return {
      status: newContent ? 'updated' : 'deleted',
      replacements: result.replacements,
      content_hash: result.contentHash,
    };
  },

  async list(_resolved) {
    const items: FilesListItem[] = [];

    try {
      if (!fs.existsSync(REPOSITORIES_DIR)) return items;
      const files = fs.readdirSync(REPOSITORIES_DIR)
        .filter(f => f.endsWith('.yaml') || f.endsWith('.yml'))
        .sort();

      for (const f of files) {
        const slug = f.replace(/\.ya?ml$/, '');
        const fullPath = path.join(REPOSITORIES_DIR, f);
        try {
          const stat = fs.statSync(fullPath);
          const content = fs.readFileSync(fullPath, 'utf-8');
          const header = parseYamlHeader(content);
          items.push({
            source: `repos/${slug}`,
            name: header.name || slug,
            description: header.description
              ? `${header.description}${header.hosts.length > 0 ? ` [${header.hosts.join(', ')}]` : ''}`
              : undefined,
            size: stat.size,
            modified: stat.mtime.toISOString(),
          });
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // repositories/ directory doesn't exist yet
    }

    return items;
  },
};
