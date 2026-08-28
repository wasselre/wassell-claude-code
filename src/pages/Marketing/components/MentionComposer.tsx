/**
 * The comment composer with @mention tagging — screens 06/07/08, the activity
 * rail, and the campaign thread. Typing «@» opens a picker of the workspace's
 * people; choosing one inserts «@Full Name» into the body AND records the pick.
 *
 * On submit the composer resolves which picks are still present in the text and
 * hands them back as user ids, so the API can drop a `mentioned_in_comment`
 * notification into each tagged person's inbox (and dashboard bell) — the whole
 * point of tagging. A pick whose «@Name» the writer deleted before posting is
 * NOT sent: you are mentioned only if your name survived to the posted text.
 *
 * Mentions render in copper (`.mn`) both while composing (no — plain in the
 * textarea) and in the posted thread (see `renderMentions`). Names carry spaces
 * (Arabic full names), so matching is by longest-name-wins scan, not a word
 * split — «@محمد آل سعود» is one chip, not «@محمد».
 */
import { useMemo, useRef, useState, type ReactNode } from 'react';
import { IconSend } from './icons';

export interface MentionPerson {
  id: string;
  name_ar: string | null;
  name_en: string | null;
  email?: string | null;
}

const displayName = (p: MentionPerson, isAr: boolean): string =>
  (isAr ? p.name_ar : p.name_en) ?? p.name_en ?? p.name_ar ?? p.email ?? '';

/**
 * Render a comment body with any «@Person Name» that matches a known person
 * lifted into a copper chip. Longest name wins so a name that is a prefix of
 * another («@محمد» vs «@محمد آل سعود») can't shadow it.
 */
export function renderMentions(
  body: string,
  people: MentionPerson[],
  isAr: boolean,
): ReactNode {
  const names = people
    .map((p) => displayName(p, isAr).trim())
    .filter((n) => n.length > 0)
    .sort((a, b) => b.length - a.length); // longest first
  if (names.length === 0) return body;

  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  let key = 0;
  const flush = (): void => {
    if (buf) { out.push(buf); buf = ''; }
  };
  while (i < body.length) {
    if (body[i] === '@') {
      const rest = body.slice(i + 1);
      const hit = names.find((n) => rest.startsWith(n));
      if (hit) {
        flush();
        out.push(<span key={`m${key++}`} className="mn">@{hit}</span>);
        i += 1 + hit.length;
        continue;
      }
    }
    buf += body[i];
    i += 1;
  }
  flush();
  return out;
}

/** The «@query» token immediately before the caret, or null. */
function activeToken(value: string, caret: number): { query: string; start: number } | null {
  const upto = value.slice(0, caret);
  // «@» must start the string or follow whitespace; the token itself has no
  // whitespace or second «@», so it ends at the caret.
  const m = upto.match(/(?:^|\s)@([^\s@]*)$/);
  if (!m) return null;
  return { query: m[1] ?? '', start: caret - (m[1]?.length ?? 0) - 1 };
}

export default function MentionComposer({
  people,
  isAr,
  busy = false,
  rows = 2,
  placeholder,
  onSubmit,
}: {
  people: MentionPerson[];
  isAr: boolean;
  busy?: boolean;
  rows?: number;
  placeholder?: string;
  /** Returns true on success so the composer can clear itself. */
  onSubmit: (body: string, mentions: string[]) => Promise<boolean>;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [picks, setPicks] = useState<Map<string, string>>(new Map());
  const [token, setToken] = useState<{ query: string; start: number } | null>(null);
  const [active, setActive] = useState(0);

  const matches = useMemo(() => {
    if (!token) return [];
    const q = token.query.trim().toLowerCase();
    const scored = people.filter((p) => {
      if (!displayName(p, isAr)) return false;
      if (q === '') return true;
      const hay = `${p.name_ar ?? ''} ${p.name_en ?? ''} ${p.email ?? ''}`.toLowerCase();
      return hay.includes(q);
    });
    return scored.slice(0, 6);
  }, [token, people, isAr]);

  const sync = (value: string): void => {
    setText(value);
    const el = ref.current;
    const caret = el ? el.selectionStart : value.length;
    const t = activeToken(value, caret);
    setToken(t);
    setActive(0);
  };

  const choose = (p: MentionPerson): void => {
    if (!token) return;
    const name = displayName(p, isAr);
    const el = ref.current;
    const caret = el ? el.selectionStart : text.length;
    const before = text.slice(0, token.start);
    const after = text.slice(caret);
    const insert = `@${name} `;
    const next = before + insert + after;
    setText(next);
    setPicks((m) => new Map(m).set(p.id, name));
    setToken(null);
    // Restore focus + caret just past the inserted mention.
    const pos = before.length + insert.length;
    requestAnimationFrame(() => {
      const node = ref.current;
      if (node) { node.focus(); node.setSelectionRange(pos, pos); }
    });
  };

  const submit = async (): Promise<void> => {
    const body = text.trim();
    if (!body || busy) return;
    // Only picks whose «@Name» survived to the posted text are mentioned.
    const mentions = [...picks.entries()]
      .filter(([, name]) => body.includes(`@${name}`))
      .map(([id]) => id);
    const ok = await onSubmit(body, mentions);
    if (ok) { setText(''); setPicks(new Map()); setToken(null); }
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (token && matches.length > 0) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((i) => (i + 1) % matches.length); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((i) => (i - 1 + matches.length) % matches.length); return; }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const p = matches[active];
        if (p) choose(p);
        return;
      }
      if (e.key === 'Escape') { e.preventDefault(); setToken(null); return; }
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); }
  };

  return (
    <div style={{ position: 'relative' }}>
      <textarea
        ref={ref}
        className="inp"
        rows={rows}
        style={{ width: '100%', fontSize: 12 }}
        placeholder={placeholder ?? (isAr ? 'اكتب تعليقًا، أو اذكر شخصًا بـ @…' : 'Write a comment, or mention someone with @…')}
        value={text}
        onChange={(e) => sync(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => { setTimeout(() => setToken(null), 120); }}
      />

      {token && matches.length > 0 && (
        <div
          role="listbox"
          style={{
            position: 'absolute',
            insetInlineStart: 0,
            insetInlineEnd: 0,
            top: '100%',
            marginTop: 4,
            zIndex: 30,
            background: 'var(--paper)',
            border: '1px solid var(--line)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.14)',
            overflow: 'hidden',
            maxHeight: 220,
            overflowY: 'auto',
          }}
        >
          {matches.map((p, i) => (
            <button
              key={p.id}
              type="button"
              role="option"
              aria-selected={i === active}
              // onMouseDown, not onClick — the textarea's onBlur would close the
              // list before a click landed.
              onMouseDown={(e) => { e.preventDefault(); choose(p); }}
              onMouseEnter={() => setActive(i)}
              style={{
                display: 'block',
                width: '100%',
                textAlign: isAr ? 'right' : 'left',
                padding: '7px 10px',
                fontSize: 12,
                cursor: 'pointer',
                border: 'none',
                background: i === active ? 'var(--sand)' : 'transparent',
                color: 'var(--ink)',
              }}
            >
              <span className="mn">@{displayName(p, isAr)}</span>
              {p.email && <span style={{ color: 'var(--mute)', marginInlineStart: 8 }}>{p.email}</span>}
            </button>
          ))}
        </div>
      )}

      {text.trim() !== '' && (
        <button
          type="button"
          className="btn btn-p btn-sm"
          style={{ marginTop: 7 }}
          disabled={busy}
          onClick={() => void submit()}
        >
          <IconSend />
          {isAr ? 'إرسال' : 'Post'}
        </button>
      )}
    </div>
  );
}
