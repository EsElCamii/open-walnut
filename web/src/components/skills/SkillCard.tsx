import type { SkillInfo } from '@/api/skills';
import { formatSize } from '@/utils/format';

interface SkillCardProps {
  skill: SkillInfo;
  selected: boolean;
  onSelect: (skill: SkillInfo) => void;
  onToggle: (dirName: string, enabled: boolean) => void;
}

export function SkillCard({ skill, selected, onSelect, onToggle }: SkillCardProps) {
  return (
    <div
      className={`skill-card card${selected ? ' skill-card-selected' : ''}${!skill.enabled ? ' skill-card-disabled' : ''}`}
      onClick={() => onSelect(skill)}
    >
      <div className="skill-card-header">
        <div className="skill-card-info">
          <div className="skill-card-name-row">
            <span className="skill-card-name">{skill.name}</span>
            <span className={`skill-source-badge ${skill.source}`}>{skill.source}</span>
            {!skill.eligible && <span className="skill-badge-ineligible">ineligible</span>}
          </div>
          {skill.description && (
            <span className="skill-card-desc text-sm text-muted">
              {skill.description.length > 120 ? skill.description.slice(0, 120) + '...' : skill.description}
            </span>
          )}
          <div className="skill-card-sizes">
            <span className="skill-size-pill" title="Description injected into every system prompt (always loaded)">
              prompt <strong>{formatSize(skill.description.length)}</strong>
            </span>
            <span className="skill-size-pill" title="Full SKILL.md loaded on-demand when skill is activated">
              doc <strong>{formatSize(skill.content.length)}</strong>
            </span>
          </div>
        </div>
        <label
          className="skill-toggle"
          onClick={(e) => e.stopPropagation()}
          title={skill.enabled ? 'Disable skill' : 'Enable skill'}
        >
          <input
            type="checkbox"
            checked={skill.enabled}
            onChange={() => onToggle(skill.dirName, !skill.enabled)}
          />
          <span className="skill-toggle-slider" />
        </label>
      </div>
    </div>
  );
}
