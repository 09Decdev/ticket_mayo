import { IconCheck } from './icons';

export interface Step {
  label: string;
}

interface StepperProps {
  steps: Step[];
  current: number; // 0-based
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <div className="stepper" role="list" aria-label="Các bước thực hiện">
      {steps.map((s, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <span key={s.label} style={{ display: 'contents' }}>
            {i > 0 && <span className={`stepper-sep${done || active ? ' done' : ''}`} aria-hidden />}
            <span
              className={`stepper-step${active ? ' active' : ''}${done ? ' done' : ''}`}
              role="listitem"
              aria-current={active ? 'step' : undefined}
            >
              <span className="step-num">{done ? <IconCheck width={13} height={13} /> : i + 1}</span>
              <span className="step-label">{s.label}</span>
            </span>
          </span>
        );
      })}
    </div>
  );
}