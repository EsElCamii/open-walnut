import { useState, useEffect } from 'react';
import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { NumberInput } from '../inputs/NumberInput';
import { KeyValueEditor } from '../inputs/KeyValueEditor';
import { ToggleSwitch } from '../inputs/ToggleSwitch';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
}

export function SessionsSection({ config, onSave }: Props) {
  const [sessionModel, setSessionModel] = useState(config.agent?.session_model ?? 'opus-1m');
  const [idleTimeout, setIdleTimeout] = useState<number | undefined>(config.session?.idle_timeout_minutes ?? 30);
  const [maxIdle, setMaxIdle] = useState<number | undefined>(config.session?.max_idle);
  const [sessionLimits, setSessionLimits] = useState<Record<string, string | number>>(config.session_limits ?? {});
  const [permissionPrompt, setPermissionPrompt] = useState(config.session?.permission_prompt ?? true);
  const ALL_MODES = ['default', 'bypass', 'plan', 'accept'] as const;
  const DEFAULT_MODES = ['bypass', 'plan'];
  const [enabledModes, setEnabledModes] = useState<string[]>(config.session?.enabled_modes ?? DEFAULT_MODES);
  const [sdkEnabled, setSdkEnabled] = useState(config.session_server?.enabled ?? false);
  const [sdkPort, setSdkPort] = useState<number | undefined>(config.session_server?.port ?? 7890);

  useEffect(() => {
    setSessionModel(config.agent?.session_model ?? 'opus-1m');
    setIdleTimeout(config.session?.idle_timeout_minutes ?? 30);
    setMaxIdle(config.session?.max_idle);
    setSessionLimits(config.session_limits ?? {});
    setPermissionPrompt(config.session?.permission_prompt ?? true);
    setEnabledModes(config.session?.enabled_modes ?? ['bypass', 'plan']);
    setSdkEnabled(config.session_server?.enabled ?? false);
    setSdkPort(config.session_server?.port ?? 7890);
  }, [config]);

  const handleSave = async () => {
    // Convert limits to numbers
    const limits: Record<string, number> = {};
    for (const [k, v] of Object.entries(sessionLimits)) {
      limits[k] = typeof v === 'number' ? v : parseInt(v, 10) || 0;
    }

    await onSave({
      agent: { ...config.agent, session_model: sessionModel },
      session: {
        idle_timeout_minutes: idleTimeout,
        max_idle: maxIdle,
        permission_prompt: permissionPrompt,
        enabled_modes: enabledModes,
      },
      session_limits: limits,
      session_server: {
        ...config.session_server,
        enabled: sdkEnabled,
        port: sdkPort,
      },
    });
  };

  return (
    <SectionCard id="sessions" title="Claude Code Session" description="Default model, timeouts, and limits for Claude Code sessions." onSave={handleSave}>
      <div className="form-group">
        <label htmlFor="session-model">Session Model</label>
        <select
          id="session-model"
          value={sessionModel}
          onChange={(e) => setSessionModel(e.target.value)}
          style={{ maxWidth: 200 }}
        >
          <option value="opus">Opus</option>
          <option value="opus-1m">Opus 1M</option>
          <option value="sonnet">Sonnet</option>
          <option value="sonnet-1m">Sonnet 1M</option>
          <option value="haiku">Haiku</option>
        </select>
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Controls the <code style={{ fontSize: 11 }}>--model</code> flag for Claude Code CLI sessions.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="form-row">
        <div className="form-group">
          <label htmlFor="idle-timeout">Idle Timeout</label>
          <NumberInput
            id="idle-timeout"
            value={idleTimeout}
            onChange={setIdleTimeout}
            suffix="minutes"
            placeholder="30"
            min={0}
          />
          <p className="text-sm text-muted" style={{ marginTop: 2 }}>
            0 = disable idle timeout.
          </p>
        </div>

        <div className="form-group">
          <label htmlFor="max-idle">Max Idle Sessions</label>
          <NumberInput
            id="max-idle"
            value={maxIdle}
            onChange={setMaxIdle}
            placeholder="30"
            min={0}
          />
        </div>
      </div>

      <div className="form-group">
        <ToggleSwitch
          id="permission-prompt"
          checked={permissionPrompt}
          onChange={setPermissionPrompt}
          label="Permission Prompt Interception"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Intercept sensitive-file and permission prompts from Claude Code.
          In bypass mode, requests are auto-approved. In other modes, prompts are forwarded to the UI.
        </p>
      </div>

      <div className="form-group">
        <label>Enabled Session Modes</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 6px' }}>
          Which modes appear in the session mode toggle cycle. At least one must be selected.
        </p>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {ALL_MODES.map(mode => {
            const icons: Record<string, string> = { default: '\u2699\uFE0F', bypass: '\u26A1', plan: '\uD83D\uDCCB', accept: '\u2705' };
            const labels: Record<string, string> = { default: 'Default', bypass: 'Bypass', plan: 'Plan', accept: 'Accept' };
            const checked = enabledModes.includes(mode);
            return (
              <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => {
                    if (checked && enabledModes.length <= 1) return; // keep at least one
                    setEnabledModes(prev =>
                      checked ? prev.filter(m => m !== mode) : [...prev, mode]
                    );
                  }}
                />
                {icons[mode]} {labels[mode]}
              </label>
            );
          })}
        </div>
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <label>Session Limits (per host)</label>
        <p className="text-sm text-muted" style={{ margin: '-4px 0 4px' }}>
          Max concurrent sessions per host. Use &quot;local&quot; for local sessions.
        </p>
        <KeyValueEditor
          entries={sessionLimits}
          onChange={setSessionLimits}
          keyPlaceholder="Host alias (e.g., local)"
          valuePlaceholder="Max sessions"
          valueType="number"
        />
      </div>

      <div className="settings-divider" />

      <div className="form-group">
        <ToggleSwitch
          id="sdk-enabled"
          checked={sdkEnabled}
          onChange={setSdkEnabled}
          label="SDK Session Server"
        />
        <p className="text-sm text-muted" style={{ marginTop: 2 }}>
          Use the Agent SDK server instead of CLI sessions.
        </p>
      </div>

      {sdkEnabled && (
        <div className="form-group">
          <label htmlFor="sdk-port">SDK Server Port</label>
          <NumberInput
            id="sdk-port"
            value={sdkPort}
            onChange={setSdkPort}
            placeholder="7890"
            min={1024}
            max={65535}
          />
        </div>
      )}
    </SectionCard>
  );
}
