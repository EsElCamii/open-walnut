import path from 'node:path';
import { ensureDir } from '../utils/fs.js';
import {
  WALNUT_HOME,
  TASKS_DIR,
  ARCHIVE_DIR,
  MEMORY_DIR,
  SESSIONS_DIR,
  PROJECTS_DIR,
  SYNC_DIR,
  DAILY_DIR,
  PROJECTS_MEMORY_DIR,
  TOPICS_DIR,
  REPOS_MEMORY_DIR,
  COMPACTION_DIR,
  NOTES_DIR,
  REPOSITORIES_DIR,
  TIMELINE_DIR,
  RECORDINGS_DIR,
  COMMANDS_DIR,
  GLOBAL_SKILLS_DIR,
  SESSION_STREAMS_DIR,
  IMAGES_DIR,
  REMOTE_IMAGES_DIR,
} from '../constants.js';
import { ensureMemoryFile } from './memory-file.js';
import { seedConfigDefaults } from './config-manager.js';

/**
 * Ensure the full ~/.open-walnut/ directory structure exists.
 * Called early in startServer() so first-run works on a fresh machine.
 */
export async function initDirectories(): Promise<void> {
  await ensureDir(WALNUT_HOME);
  await ensureDir(TASKS_DIR);
  await ensureDir(ARCHIVE_DIR);
  await ensureDir(MEMORY_DIR);
  await ensureDir(SESSIONS_DIR);
  await ensureDir(PROJECTS_DIR);
  await ensureDir(SYNC_DIR);
  await ensureDir(DAILY_DIR);
  await ensureDir(PROJECTS_MEMORY_DIR);
  await ensureDir(TOPICS_DIR);
  await ensureDir(REPOS_MEMORY_DIR);
  await ensureDir(COMPACTION_DIR);
  await ensureDir(NOTES_DIR);
  await ensureDir(path.join(NOTES_DIR, 'Areas'));
  await ensureDir(path.join(NOTES_DIR, 'Projects'));
  await ensureDir(path.join(NOTES_DIR, 'Resources'));
  await ensureDir(path.join(NOTES_DIR, 'Archive'));
  await ensureDir(REPOSITORIES_DIR);
  await ensureDir(TIMELINE_DIR);
  await ensureDir(RECORDINGS_DIR);
  await ensureDir(COMMANDS_DIR);
  await ensureDir(GLOBAL_SKILLS_DIR);
  await ensureDir(SESSION_STREAMS_DIR);
  await ensureDir(IMAGES_DIR);
  await ensureDir(REMOTE_IMAGES_DIR);
  ensureMemoryFile();
  await seedConfigDefaults();
}
