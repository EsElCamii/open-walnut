/**
 * SSE-based setup progress component.
 * Runs a sequence of setup steps (brew install / model download),
 * showing live progress for each.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { startSetup, type SetupEvent } from '@/api/stt';

interface SetupStep {
  action: string;
  params: Record<string, string>;
  label: string;
}

interface Props {
  steps: SetupStep[];
  onComplete: () => void;
  onCancel: () => void;
}

interface StepState {
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  percent: number;
  message: string;
  logs: string[];
}

export function SttSetupProgress({ steps, onComplete, onCancel }: Props) {
  const [stepStates, setStepStates] = useState<StepState[]>(
    steps.map(s => ({ label: s.label, status: 'pending', percent: 0, message: '', logs: [] }))
  );
  const [currentIdx, setCurrentIdx] = useState(0);
  const [finished, setFinished] = useState(false);
  const [failed, setFailed] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const runningRef = useRef(false);

  const updateStep = useCallback((idx: number, update: Partial<StepState>) => {
    setStepStates(prev => prev.map((s, i) => i === idx ? { ...s, ...update } : s));
  }, []);

  useEffect(() => {
    if (runningRef.current) return;
    runningRef.current = true;

    const runSteps = async () => {
      for (let i = 0; i < steps.length; i++) {
        setCurrentIdx(i);
        updateStep(i, { status: 'running', percent: 0, message: 'Starting...' });

        const controller = new AbortController();
        abortRef.current = controller;

        let stepFailed = false;

        await startSetup(
          steps[i].action,
          steps[i].params,
          (event: SetupEvent) => {
            if (event.type === 'progress') {
              updateStep(i, {
                percent: event.percent ?? 0,
                message: event.message ?? '',
              });
            } else if (event.type === 'log') {
              setStepStates(prev => prev.map((s, idx) =>
                idx === i ? { ...s, logs: [...s.logs, event.message ?? ''] } : s
              ));
            } else if (event.type === 'done') {
              updateStep(i, { status: 'done', percent: 100, message: event.message ?? 'Done' });
            } else if (event.type === 'error') {
              updateStep(i, { status: 'error', message: event.message ?? 'Failed' });
              stepFailed = true;
            }
          },
          controller.signal,
        );

        abortRef.current = null;

        if (stepFailed) {
          setFailed(true);
          return;
        }

        // Ensure step is marked done if SSE didn't send explicit done event
        setStepStates(prev => {
          const s = prev[i];
          if (s.status === 'running') {
            return prev.map((st, idx) => idx === i ? { ...st, status: 'done', percent: 100 } : st);
          }
          return prev;
        });
      }

      setFinished(true);
    };

    runSteps();

    return () => {
      abortRef.current?.abort();
    };
  }, []); // Run once on mount

  const handleCancel = () => {
    abortRef.current?.abort();
    onCancel();
  };

  return (
    <div className="stt-setup-progress">
      {stepStates.map((step, i) => (
        <div key={i} className={`stt-setup-step stt-step-${step.status}`}>
          <div className="stt-step-header">
            <span className="stt-step-indicator">
              {step.status === 'done' ? '\u2713' : step.status === 'error' ? '\u2717' : step.status === 'running' ? '\u25CB' : '\u2022'}
            </span>
            <span className="stt-step-label">{step.label}</span>
            {step.status === 'running' && step.percent > 0 && (
              <span className="stt-step-percent">{step.percent}%</span>
            )}
          </div>

          {step.status === 'running' && (
            <div className="stt-progress-bar-track">
              <div
                className="stt-progress-bar-fill"
                style={{ width: `${step.percent}%` }}
              />
            </div>
          )}

          {step.message && step.status !== 'pending' && (
            <p className="stt-step-message">{step.message}</p>
          )}
        </div>
      ))}

      <div className="stt-setup-actions">
        {finished && (
          <button className="btn btn-sm btn-primary" onClick={onComplete}>
            Done — Apply Config
          </button>
        )}
        {failed && (
          <button className="btn btn-sm" onClick={onComplete}>
            Retry
          </button>
        )}
        {!finished && (
          <button className="btn btn-sm" onClick={handleCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
