// The mission stepper — the guided journey across the top of the Follow-up Workspace.
// Steps are a GUIDE, not a wizard: every step is clickable (jump anywhere), and the
// Outcome step is always one tap away, so a "no answer" call can be recorded instantly.

import { Check } from 'lucide-react';
import { STAGE_LABELS, type MissionStage } from '../lib/missionStages';

interface MissionStepperProps {
  stages: MissionStage[];
  current: MissionStage;
  onJump: (stage: MissionStage) => void;
  isAr: boolean;
}

export default function MissionStepper({ stages, current, onJump, isAr }: MissionStepperProps) {
  const currentIdx = stages.indexOf(current);
  return (
    <nav className="card p-2">
      <ol className="flex items-center gap-0.5 overflow-x-auto">
        {stages.map((s, i) => {
          const done = i < currentIdx;
          const active = i === currentIdx;
          return (
            <li key={s} className="flex shrink-0 items-center gap-0.5">
              <button
                type="button"
                onClick={() => onJump(s)}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm font-semibold transition ${
                  active ? 'bg-copper text-white' : done ? 'text-copper hover:bg-cream' : 'text-charcoal/50 hover:bg-cream'
                }`}
              >
                <span
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] ${
                    active ? 'bg-white/25' : done ? 'bg-copper/15 text-copper' : 'bg-sand/40 text-charcoal/50'
                  }`}
                >
                  {done ? <Check size={12} /> : i + 1}
                </span>
                {isAr ? STAGE_LABELS[s].ar : STAGE_LABELS[s].en}
              </button>
              {i < stages.length - 1 ? <span className="px-0.5 text-charcoal/20">{isAr ? '←' : '→'}</span> : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
