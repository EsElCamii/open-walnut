import type { Config } from '@open-walnut/core';
import { SectionCard } from '../inputs/SectionCard';
import { SttDetectionPanel } from './SttDetectionPanel';
import { invalidateSttStatusCache } from '@/hooks/useSttStatus';

interface Props {
  config: Config;
  onSave: (partial: Partial<Config>) => Promise<void>;
  onReload?: () => void;
}

export function SttSection({ config, onSave, onReload }: Props) {
  const handleConfigured = () => {
    invalidateSttStatusCache();
    onReload?.();
  };

  return (
    <SectionCard
      id="stt"
      title="Speech-to-Text"
      description="Configure voice input for all text fields. Click the microphone button to dictate."
    >
      <SttDetectionPanel
        config={config}
        onSave={onSave}
        onConfigured={handleConfigured}
      />
    </SectionCard>
  );
}
