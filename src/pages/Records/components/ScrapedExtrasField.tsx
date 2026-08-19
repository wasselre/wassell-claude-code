/**
 * Read-only renderer for the `scraped_extras` field (عناصر مستخرجة): the catch-all
 * for extracted details that have no dedicated column. The value is an array of
 * `{ raw_label, details, source_section }` — NOT the comment-entry shape NotesField
 * expects — so it needs its own grid. Display-only: these come from the scraper.
 */

interface Extra {
  element?: string;
  raw_label?: string;
  details?: string;
  source_section?: string;
}

export default function ScrapedExtrasField({ value }: { value: unknown }) {
  const items = Array.isArray(value)
    ? (value as Extra[]).filter((e) => e && (e.raw_label || e.details))
    : [];

  if (items.length === 0) {
    return (
      <div className="form-input bg-sand/5 text-charcoal/40 italic cursor-default">
        لا توجد تفاصيل مستخرجة
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-sand/40 overflow-hidden">
      {items.map((e, i) => (
        <div
          key={i}
          className="flex items-start justify-between gap-4 px-3 py-2 text-sm odd:bg-sand/5 border-b border-sand/20 last:border-b-0"
        >
          <span className="text-charcoal/55 shrink-0">{e.raw_label || '—'}</span>
          <span className="text-charcoal font-medium text-right break-words">{e.details || '—'}</span>
        </div>
      ))}
    </div>
  );
}
