/**
 * ext-index-registry.ts — module-level registry of plugin ext-index specs.
 *
 * Standalone module (no other internal imports) so that both the integration
 * loader (writer) and task-manager (reader) can talk to it without a circular
 * dependency between those two larger modules.
 *
 * Plugins declare their ext-id indexes via `PluginApi.registerExtIndex` during
 * load. The loader calls `setExtIndexes()` once with the collected specs;
 * task-manager calls `getExtIndexSpec(source)` on the lookup hot path.
 */

import type { ExtIndexSpec } from './integration-types.js';

const specs: Map<string, ExtIndexSpec> = new Map();

/** Replace the entire registry with the given specs. Called by the loader. */
export function setExtIndexes(next: Iterable<ExtIndexSpec>): void {
  specs.clear();
  for (const spec of next) {
    specs.set(spec.source, spec);
  }
}

/** Read-only view for callers that want to iterate. */
export function getRegisteredExtIndexes(): ReadonlyMap<string, ExtIndexSpec> {
  return specs;
}

/** Hot-path lookup. Returns undefined for un-registered sources. */
export function getExtIndexSpec(source: string): ExtIndexSpec | undefined {
  return specs.get(source);
}

/** Test hook — wipe the registry between cases. */
export function _resetForTesting(): void {
  specs.clear();
}
