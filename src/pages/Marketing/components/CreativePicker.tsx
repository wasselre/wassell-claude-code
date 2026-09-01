/**
 * CreativePicker — a VISUAL library for choosing an ad's creative (a content
 * record), replacing the plain <select> of refs.
 *
 * The operator's point (2026-09-01): when you attach a creative to a Meta ad you
 * need to SEE the actual creative, not pick a code out of a dropdown. So this
 * renders the Content list as a searchable grid of thumbnail cards (the same
 * preview the content list already computes — `thumb_url` for legacy public
 * assets, `preview_file_id` signed on the fly for canonical ones), plus a
 * "no creative" card and a typed placeholder when an item has no renderable
 * preview.
 *
 * Pure presentation over `content_id`: picking a card calls onChange with that
 * content record's id (or '' for none) — the same value the old select emitted,
 * so linking an ad to a content record still makes it a paid placement.
 */
import { useMemo, useState } from 'react';
import { MosAsset, MosContentRow } from '@/lib/marketingOS/client';
import { useAssetUrls } from '../lib/assetUrls';

interface CreativePickerProps {
  /** The content-list rows (fetched once by the parent) — carry preview fields. */
  contentOptions: MosContentRow[];
  /** The currently-attached content record id ('' = none). */
  value: string;
  isAr: boolean;
  onChange: (contentId: string) => void;
}

/** Map a content row's preview fields to the shape useAssetUrls resolves. */
function previewAsset(c: MosContentRow): Pick<MosAsset, 'file_id' | 'url' | 'thumb_url' | 'kind'> & { mime_type: string | null } {
  return {
    file_id: c.preview_file_id ?? null,
    url: null,
    thumb_url: c.thumb_url ?? null,
    // preview_kind comes from mos_assets.kind server-side. When absent there is
    // no preview asset (file_id is null too), so the kind is unused — default it
    // to a non-image kind so the type stays the real MosAsset union.
    kind: (c.preview_kind ?? 'document') as MosAsset['kind'],
    mime_type: null,
  };
}

export default function CreativePicker({
  contentOptions, value, isAr, onChange,
}: CreativePickerProps): JSX.Element {
  const [q, setQ] = useState('');

  // Sign any canonical previews once for the whole grid (legacy thumbs pass
  // through verbatim; useAssetUrls no-ops when nothing needs signing).
  const { thumbFor, loading, error, retry } = useAssetUrls(
    useMemo(() => contentOptions.map(previewAsset), [contentOptions]),
  );

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return contentOptions;
    return contentOptions.filter((c) =>
      (c.ref ?? '').toLowerCase().includes(needle) || c.title.toLowerCase().includes(needle));
  }, [contentOptions, q]);

  const selected = value ? contentOptions.find((c) => c.id === value) ?? null : null;

  const typeLabel = (c: MosContentRow): string =>
    (isAr ? c.content_type_label_ar : c.content_type_label_en) || '';

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <input
        className="inp"
        value={q}
        placeholder={isAr ? 'ابحث في المحتوى بالرمز أو العنوان…' : 'Search content by code or title…'}
        onChange={(e) => setQ(e.target.value)}
      />

      {error && (
        <div style={{ fontSize: 11.5, color: 'var(--late)' }}>
          {isAr ? 'تعذّر تحميل بعض المعاينات.' : 'Some previews could not load.'}{' '}
          <button type="button" className="lnk" onClick={retry} style={{ textDecoration: 'underline' }}>
            {isAr ? 'إعادة المحاولة' : 'Retry'}
          </button>
        </div>
      )}

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(128px, 1fr))',
          gap: 8,
          maxHeight: 340,
          overflowY: 'auto',
          padding: 2,
        }}
      >
        {/* "No creative" card — always first. */}
        <CardShell selected={value === ''} onClick={() => onChange('')}>
          <div
            style={{
              aspectRatio: '4 / 3', display: 'flex', alignItems: 'center', justifyContent: 'center',
              color: 'var(--mute)', fontSize: 12, borderRadius: 7,
              background: 'color-mix(in srgb, var(--mute) 8%, transparent)',
            }}
          >
            {isAr ? 'بدون كرييتف' : 'No creative'}
          </div>
        </CardShell>

        {filtered.map((c) => {
          const thumb = thumbFor(previewAsset(c));
          const isSel = c.id === value;
          return (
            <CardShell key={c.id} selected={isSel} onClick={() => onChange(c.id)}>
              <div
                style={{
                  aspectRatio: '4 / 3', borderRadius: 7, overflow: 'hidden',
                  background: 'color-mix(in srgb, var(--gold) 10%, transparent)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                }}
              >
                {thumb ? (
                  <img
                    src={thumb}
                    alt={c.title}
                    loading="lazy"
                    decoding="async"
                    style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                  />
                ) : (
                  <span style={{ fontSize: 11, color: 'var(--mute)', textAlign: 'center', padding: 6 }}>
                    {typeLabel(c) || (loading ? '…' : (isAr ? 'لا معاينة' : 'No preview'))}
                  </span>
                )}
              </div>
              <div style={{ padding: '5px 6px 6px', display: 'grid', gap: 1 }}>
                <span className="ltr" style={{ fontSize: 10.5, color: 'var(--mute)' }}>{c.ref ?? '—'}</span>
                <span
                  style={{
                    fontSize: 11.5, lineHeight: 1.3, overflow: 'hidden',
                    display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  }}
                >
                  {c.title}
                </span>
              </div>
            </CardShell>
          );
        })}

        {filtered.length === 0 && (
          <div style={{ gridColumn: '1 / -1', fontSize: 12, color: 'var(--mute)', padding: '10px 2px' }}>
            {isAr ? 'لا محتوى مطابق.' : 'No matching content.'}
          </div>
        )}
      </div>

      {selected && (
        <span style={{ fontSize: 11.5, color: 'var(--mute)' }}>
          {isAr
            ? `المختار: ${selected.ref ? `${selected.ref} · ` : ''}${selected.title} — يُسجَّل هذا الإعلان كموضع مدفوع على هذا المحتوى.`
            : `Selected: ${selected.ref ? `${selected.ref} · ` : ''}${selected.title} — this ad is recorded as a paid placement on it.`}
        </span>
      )}
    </div>
  );
}

/** One selectable tile with the shared selected-ring treatment. */
function CardShell({
  selected, onClick, children,
}: {
  selected: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        textAlign: 'start',
        border: selected
          ? '2px solid var(--go)'
          : '1px solid var(--line, rgba(255,255,255,0.12))',
        borderRadius: 9,
        overflow: 'hidden',
        background: selected
          ? 'color-mix(in srgb, var(--go) 10%, transparent)'
          : 'var(--panel, rgba(255,255,255,0.03))',
        padding: selected ? 3 : 4,
        cursor: 'pointer',
        display: 'block',
      }}
    >
      {children}
    </button>
  );
}
