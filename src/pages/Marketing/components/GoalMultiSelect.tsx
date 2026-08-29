/**
 * A multi-select of marketing goals for the campaign brief.
 *
 * Every campaign serves at least one goal, and may serve several — so this is a
 * set of toggle chips rather than a single <select>. Goals are few, so a flat
 * wrap of pills reads better than a searchable dropdown. It loads the active
 * goals itself (plus any already-selected inactive one, so an edit never drops a
 * link the user can still see), and styles with the MOS CSS variables so it
 * matches both the light content modal and the dark campaign panel.
 */
import { useEffect, useMemo, useState } from 'react';
import { MosGoal, fetchGoals } from '@/lib/marketingOS/client';

interface Props {
  /** Selected goal ids. */
  value: string[];
  onChange: (ids: string[]) => void;
  isAr: boolean;
  disabled?: boolean;
  /** Fired once the goals load, so a parent can resolve id → name (auto-naming). */
  onLoaded?: (goals: MosGoal[]) => void;
}

export default function GoalMultiSelect({ value, onChange, isAr, disabled = false, onLoaded }: Props): JSX.Element {
  const [goals, setGoals] = useState<MosGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const g = (await fetchGoals()).goals;
        if (alive) { setGoals(g); onLoaded?.(g); }
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
    // onLoaded is a stable callback from the parent; re-running the fetch on its
    // identity change is neither wanted nor expected.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Show active goals, plus any already-selected goal even if it went inactive.
  const options = useMemo(() => {
    const chosen = new Set(value);
    return goals.filter((g) => g.is_active || chosen.has(g.id));
  }, [goals, value]);

  const toggle = (id: string): void => {
    if (disabled) return;
    onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  };

  if (loading) {
    return <div style={{ fontSize: 12, color: 'var(--mute)' }}>{isAr ? 'جارٍ تحميل الأهداف…' : 'Loading goals…'}</div>;
  }
  if (error) {
    return <div style={{ fontSize: 12, color: 'var(--late)' }}>{error}</div>;
  }
  if (options.length === 0) {
    return (
      <div style={{ fontSize: 12, color: 'var(--mute)', lineHeight: 1.7 }}>
        {isAr
          ? 'لا أهداف بعد. أنشئ هدفًا من تبويب «الأهداف» أولًا — كل حملة تُربط بهدف واحد على الأقل.'
          : 'No goals yet. Create one in the Goals tab first — every campaign links to at least one.'}
      </div>
    );
  }

  const chosenNames = options.filter((g) => value.includes(g.id)).map((g) => g.name);
  const summary = chosenNames.length > 0
    ? chosenNames.join('، ')
    : (isAr ? 'اختر الأهداف…' : 'Choose goals…');

  return (
    <div style={{ position: 'relative' }}>
      <button
        type="button"
        className="inp"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        style={{
          width: '100%', display: 'flex', alignItems: 'center', gap: 8, cursor: disabled ? 'not-allowed' : 'pointer',
          textAlign: isAr ? 'right' : 'left', fontSize: 13,
          color: chosenNames.length > 0 ? 'var(--ink)' : 'var(--mute)',
        }}
      >
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summary}
        </span>
        <span style={{ fontSize: 11, color: 'var(--mute)' }}>▾</span>
      </button>

      {open && !disabled && (
        <>
          {/* Click-away catcher. */}
          <div
            style={{ position: 'fixed', inset: 0, zIndex: 40 }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: 'absolute', zIndex: 41, top: 'calc(100% + 4px)', insetInline: 0,
              background: 'var(--paper)', border: '1px solid var(--line)', borderRadius: 10,
              boxShadow: '0 10px 30px rgba(0,0,0,0.25)', padding: 5, maxHeight: 260, overflowY: 'auto',
            }}
          >
            {options.map((g) => {
              const selected = value.includes(g.id);
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggle(g.id)}
                  title={g.description ?? undefined}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: 8,
                    padding: '7px 9px', borderRadius: 7, border: 0, cursor: 'pointer',
                    background: selected ? 'color-mix(in srgb, var(--copper) 14%, transparent)' : 'transparent',
                    color: 'var(--ink)', textAlign: isAr ? 'right' : 'left', fontSize: 13,
                    fontWeight: selected ? 700 : 400,
                  }}
                >
                  <span style={{ width: 14, fontSize: 11, color: 'var(--copper)' }}>{selected ? '✓' : ''}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>{g.name}</span>
                  {!g.is_active && (
                    <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                      {isAr ? '(معطّل)' : '(inactive)'}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
