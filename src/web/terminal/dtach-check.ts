/**
 * dtach availability check. Terminal sessions need a working `dtach` on the
 * target host (it keeps the shell alive across ssh/server death). Unlike the
 * old tmux probe, "checking" here IS provisioning: dtach isn't in dev-host
 * package repos, so we compile the embedded source on demand (see
 * dtach-provision.ts) and the check succeeds iff that yields a runnable binary.
 *
 * If provisioning is impossible (no compiler), we return a structured error so
 * the UI shows an install hint + retry — never a silent state-losing shell.
 */

import type { SessionRecord } from '../../core/types.js'
import { localDtachPath, remoteDtachPath, DtachProvisionError } from './dtach-provision.js'
import { log } from '../../logging/index.js'

export type DtachProbe =
  | { ok: true }
  | { ok: false; code: 'NO_DTACH'; host?: string; installHint: string }

/** Install hint shown when we couldn't provision dtach (missing compiler). */
function installHint(host?: string): string {
  const where = host ? `目标主机 (${host})` : '本机'
  return (
    `无法在${where}上自动编译 dtach(终端持久化需要它)。` +
    `通常因为缺少 C 编译器。请安装编译工具后重试,例如:\n` +
    `  Linux:  sudo yum install -y gcc   # 或 sudo apt-get install -y gcc\n` +
    `  macOS:  xcode-select --install`
  )
}

/** Probe (= provision) dtach for a session, local or remote. */
export async function probeDtach(record: SessionRecord): Promise<DtachProbe> {
  try {
    // Provision (side-effect) to ensure dtach exists + warm the ControlMaster;
    // the path is reused by spawn via the same per-host cache, not returned here.
    if (record.host) await remoteDtachPath(record.host)
    else await localDtachPath()
    return { ok: true }
  } catch (err) {
    const detail = err instanceof DtachProvisionError ? err.detail : undefined
    log.web.warn('terminal dtach probe failed', { host: record.host, error: String(err), detail: detail?.slice(-300) })
    return { ok: false, code: 'NO_DTACH', host: record.host, installHint: installHint(record.host) }
  }
}
