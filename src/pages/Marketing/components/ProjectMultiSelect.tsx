/**
 * A searchable, multi-select picker for Our Projects.
 *
 * Replaces the old single <select> on the campaign + content forms: a campaign
 * or content item can now be tied to SEVERAL projects. Options are Our Projects
 * only (the parent passes the already-filtered `projects` from the workspace,
 * which the server restricts to all_projects.is_public = true).
 *
 * Self-contained and styled with the MOS CSS variables (var(--paper)/(--line)/…)
 * so it matches whatever context it renders in — the light content modal or the
 * dark campaign panel — without its own stylesheet.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { MosProject } from '@/lib/marketingOS/client';

interface Props {
  /** Our Projects — the option pool (already restricted server-side). */
  projects: MosProject[];
  /** Selected project ids (order preserved; the first is the primary). */
  value: string[];
  onChange: (ids: string[]) => void;
  isAr: boolean;
  /** Disable interaction (e.g. read-only role). */
  disabled?: boolean;
}

const nameOf = (p: MosProject, isAr: boolean): string =>
  p.project_name ?? (isAr ? `مشروع ${p.id.slice(0, 6)}` : `Project ${p.id.slice(0, 6)}`);

export default function ProjectMultiSelect({
  projects, value, onChange, isAr, disabled = false,
}: Props): JSX.Element {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const byId = useMemo(() => {
    const m = new Map<string, MosProject>();
    for (const p of projects) m.set(p.id, p);
    return m;
  }, [projects]);

  // Options: not-yet-selected, matching the query (case-insensitive substring).
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    const chosen = new Set(value);
    return projects
      .filter((p) => !chosen.has(p.id))
      .filter((p) => !q || nameOf(p, isAr).toLowerCase().includes(q));
  }, [projects, value, query, isAr]);

  // Close on outside click so the dropdown never lingers over the form.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const add = (id: string): void => {
    if (!value.includes(id)) onChange([...value, id]);
    setQuery('');
    inputRef.current?.focus();
  };
  const remove = (id: string): void => onChange(value.filter((v) => v !== id));

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    const first = matches[0];
    const last = value[value.length - 1];
    if (e.key === 'Enter' && first) {
      e.preventDefault();
      add(first.id);
    } else if (e.key === 'Backspace' && query === '' && last) {
      remove(last);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const box: CSSProperties = {
    display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 5,
    minHeight: 38, padding: '4px 6px', borderRadius: 7,
    border: '1px solid var(--line)', background: disabled ? 'var(--sand-2)' : 'var(--paper)',
    cursor: disabled ? 'not-allowed' : 'text', position: 'relative',
  };
  const chip: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', gap: 5,
    padding: '2px 4px 2px 9px', borderRadius: 6, fontSize: 12, lineHeight: 1.6,
    background: 'color-mix(in srgb, var(--copper) 14%, transparent)',
    color: 'var(--choc)', border: '1px solid color-mix(in srgb, var(--copper) 30%, transparent)',
    maxWidth: '100%',
  };
  const chipX: CSSProperties = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 16, height: 16, borderRadius: 4, border: 'none', cursor: 'pointer',
    background: 'transparent', color: 'var(--choc)', fontSize: 13, lineHeight: 1, padding: 0,
  };
  const panel: CSSProperties = {
    position: 'absolute', top: 'calc(100% + 4px)', insetInlineStart: 0, insetInlineEnd: 0,
    zIndex: 60, maxHeight: 240, overflowY: 'auto', background: 'var(--paper)',
    border: '1px solid var(--line)', borderRadius: 7, boxShadow: 'var(--shadow)', padding: 4,
  };
  const opt: CSSProperties = {
    padding: '7px 10px', borderRadius: 5, fontSize: 13, color: 'var(--ink)',
    cursor: 'pointer', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative' }}>
      <div
        style={box}
        onClick={() => { if (!disabled) { setOpen(true); inputRef.current?.focus(); } }}
      >
        {value.map((id) => {
          const p = byId.get(id);
          const label = p ? nameOf(p, isAr) : (isAr ? `مشروع ${id.slice(0, 6)}` : `Project ${id.slice(0, 6)}`);
          return (
            <span key={id} style={chip} title={label}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 }}>{label}</span>
              {!disabled && (
                <button
                  type="button"
                  style={chipX}
                  aria-label={isAr ? `إزالة ${label}` : `Remove ${label}`}
                  onClick={(e) => { e.stopPropagation(); remove(id); }}
                >×</button>
              )}
            </span>
          );
        })}
        {!disabled && (
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
            onFocus={() => setOpen(true)}
            onKeyDown={onKeyDown}
            placeholder={value.length === 0 ? (isAr ? 'ابحث عن مشروع…' : 'Search a project…') : ''}
            style={{
              flex: 1, minWidth: 90, border: 'none', outline: 'none', background: 'transparent',
              color: 'var(--ink)', font: 'inherit', fontSize: 13, padding: '3px 2px',
            }}
          />
        )}
      </div>

      {open && !disabled && (
        <div style={panel} role="listbox">
          {matches.length === 0 ? (
            <div style={{ ...opt, color: 'var(--mute)', cursor: 'default' }}>
              {projects.length === 0
                ? (isAr ? 'لا مشاريع' : 'No projects')
                : value.length >= projects.length
                  ? (isAr ? 'تم اختيار كل المشاريع' : 'All projects selected')
                  : (isAr ? 'لا مشاريع مطابقة' : 'No matching projects')}
            </div>
          ) : (
            matches.map((p) => {
              const label = nameOf(p, isAr);
              return (
                <div
                  key={p.id}
                  role="option"
                  aria-selected={false}
                  style={opt}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => add(p.id)}
                  onMouseEnter={(e) => { (e.currentTarget.style.background = 'var(--sand-2)'); }}
                  onMouseLeave={(e) => { (e.currentTarget.style.background = 'transparent'); }}
                  title={label}
                >{label}</div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}
