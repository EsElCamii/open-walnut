import type { SkillInfo } from '@/api/skills';

interface SkillCardProps {
  skill: SkillInfo;
  selected: boolean;
  onSelect: (skill: SkillInfo) => void;
  onToggle: (dirName: string, enabled: boolean) => void;
}

function fmtSize(chars: number): string {
  if (chars < 1024) return `${chars} B`;
  return `${(chars / 1024).toFixed(1)} KB`;
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
            <span className="skill-size-badge" title={`desc ${fmtSize(skill.description.length)} · doc ${fmtSize(skill.content.length)}`}>
              {fmtSize(skill.content.length)}
            </span>
          </div>
          {skill.description && (
            <span className="skill-card-desc text-sm text-muted">
              {skill.description.length > 120 ? skill.description.slice(0, 120) + '...' : skill.description}
            </span>
          )}
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
