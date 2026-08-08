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
import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { MosGoal, fetchGoals } from '@/lib/marketingOS/client';

interface Props {
  /** Selected goal ids. */
  value: string[];
  onChange: (ids: string[]) => void;
  isAr: boolean;
  disabled?: boolean;
}

export default function GoalMultiSelect({ value, onChange, isAr, disabled = false }: Props): JSX.Element {
  const [goals, setGoals] = useState<MosGoal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const g = (await fetchGoals()).goals;
        if (alive) setGoals(g);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
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

  const chip = (selected: boolean): CSSProperties => ({
    display: 'inline-flex', alignItems: 'center', gap: 6,
    padding: '5px 11px', borderRadius: 999, fontSize: 12.5, lineHeight: 1.5,
    cursor: disabled ? 'not-allowed' : 'pointer',
    border: selected
      ? '1px solid color-mix(in srgb, var(--copper) 55%, transparent)'
      : '1px solid var(--line)',
    background: selected
      ? 'color-mix(in srgb, var(--copper) 16%, transparent)'
      : 'var(--paper)',
    color: selected ? 'var(--choc)' : 'var(--ink)',
    fontWeight: selected ? 700 : 400,
  });

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

  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 7 }}>
      {options.map((g) => {
        const selected = value.includes(g.id);
        return (
          <button
            key={g.id}
            type="button"
            style={chip(selected)}
            disabled={disabled}
            aria-pressed={selected}
            onClick={() => toggle(g.id)}
            title={g.description ?? undefined}
          >
            {selected && <span style={{ fontSize: 11 }}>✓</span>}
            {g.name}
            {!g.is_active && (
              <span style={{ fontSize: 10.5, color: 'var(--mute)' }}>
                {isAr ? '(معطّل)' : '(inactive)'}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
