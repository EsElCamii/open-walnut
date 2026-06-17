import { describe, it, expect } from 'vitest';
import { DTACH_SOURCES, DTACH_VERSION } from '../../../src/web/terminal/dtach-sources.js';

/**
 * Guards on the embedded dtach source. The provisioner compiles these on the
 * target host; if the embed step ever drops a file or corrupts the base64, the
 * remote `gcc` would fail with a confusing error — catch it here instead.
 */
describe('embedded dtach sources', () => {
  it('embeds all files needed for a standalone gcc build', () => {
    for (const f of ['attach.c', 'main.c', 'master.c', 'dtach.h', 'config.h']) {
      expect(DTACH_SOURCES[f], `missing ${f}`).toBeTruthy();
    }
    expect(DTACH_VERSION).toBe('0.9');
  });

  it('base64 decodes to plausible C source (not truncated/corrupt)', () => {
    const master = Buffer.from(DTACH_SOURCES['master.c'], 'base64').toString('utf-8');
    // master.c holds the detached process loop — sanity-check known content.
    expect(master).toMatch(/dtach/i);
    expect(master.length).toBeGreaterThan(5000);

    const header = Buffer.from(DTACH_SOURCES['dtach.h'], 'base64').toString('utf-8');
    expect(header).toContain('MSG_PUSH');
    expect(header).toContain('MSG_WINCH');
  });

  it('config.h is the portable hand-written one (no autotools needed)', () => {
    const cfg = Buffer.from(DTACH_SOURCES['config.h'], 'base64').toString('utf-8');
    // Must define the macros the source references, for both platforms.
    expect(cfg).toContain('PACKAGE_VERSION');
    expect(cfg).toContain('RETSIGTYPE');
    expect(cfg).toContain('HAVE_FORKPTY');
    expect(cfg).toMatch(/__APPLE__/); // branches macOS (util.h) vs Linux (pty.h)
  });
});
