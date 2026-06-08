import { useMemo, useState } from 'react';
import { Search, User } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { useApplyViewScope } from '@/hooks/usePermission';
import { collectViewFields, type ExpandedField } from '@/lib/sectionMirrorExpand';
import {
  buildRecordSearchText,
  buildExpandedFieldSearchText,
  normalizeForSearch,
} from '@/lib/recordSearch';
import { phoneFieldSlugs } from '@/lib/haberchat/normalize';
import type { AppModel, AppRecord } from '@/types';

/**
 * The shape the StartChatModal needs from a chosen client: the record id
 * (for chat linking), the business identifier (auto_id, e.g. "CLT-0042"),
 * the display name, and the phone (for auto-fill + send). Phone may be null
 * if the client record has no phone yet — the modal disables Send in that
 * case rather than silently failing.
 */
export interface PickedClient {
  recordId: string;
  code: string | null;
  name: string;
  phone: string | null;
}

export interface ClientSlugs {
  codeSlug: string | null;
  nameSlug: string | null;
  phoneSlug: string | null;
}

/**
 * Resolve which field slugs hold the business code / name / phone on the
 * clients model. Resolved from the schema (not hardcoded) so an admin
 * renaming or re-ordering Builder fields doesn't break the picker:
 *   - business id = first `auto_id` field (seeded: `client_code`)
 *   - name        = the card-title field, else the first `text` field
 *   - phone       = the first `phone` field (reuses `phoneFieldSlugs`)
 *
 * Exported so the manual-entry match hint in StartChatModal resolves the
 * same slugs as the picker.
 */
export function resolveClientSlugs(model: AppModel | undefined): ClientSlugs {
  const fields = model ? model.schema.sections.flatMap((s) => s.fields) : [];
  const codeSlug = fields.find((f) => f.type === 'auto_id')?.name ?? null;
  const titleId = model?.card_config?.title_field_id ?? null;
  const nameSlug =
    fields.find((f) => f.id === titleId)?.name ??
    fields.find((f) => f.type === 'text')?.name ??
    null;
  const phoneSlug = phoneFieldSlugs(model)[0] ?? null;
  return { codeSlug, nameSlug, phoneSlug };
}

/**
 * Build a `PickedClient` from a client record + resolved slugs. Shared by the
 * picker result rows AND the StartChatModal manual-entry match hint, so both
 * surfaces render code / name / phone identically.
 */
export function recordToPickedClient(rec: AppRecord, slugs: ClientSlugs, isAr: boolean): PickedClient {
  const d = rec.data as Record<string, unknown>;
  const code = slugs.codeSlug && typeof d[slugs.codeSlug] === 'string' ? (d[slugs.codeSlug] as string) : null;
  const name =
    slugs.nameSlug && typeof d[slugs.nameSlug] === 'string' && (d[slugs.nameSlug] as string).trim()
      ? (d[slugs.nameSlug] as string)
      : isAr
        ? '(بدون اسم)'
        : '(no name)';
  const phone = slugs.phoneSlug && typeof d[slugs.phoneSlug] === 'string' ? (d[slugs.phoneSlug] as string) : null;
  return { recordId: rec.id, code, name, phone };
}

/**
 * Advanced client picker for the Start New Chat flow. Reuses the same search
 * engine as the Record Table View — "All fields" or a single scoped field —
 * via `recordSearch.ts` + `collectViewFields`, and respects the user's
 * view-scope on the Clients model via `useApplyViewScope`. Renders inline
 * (not an absolute popover) so it composes cleanly inside the modal body.
 *
 * Selection state lives in the parent (StartChatModal); this component is a
 * pure search-and-pick surface that calls `onPick` with a fully-resolved
 * `PickedClient`.
 */
export default function ClientPicker({ onPick }: { onPick: (client: PickedClient) => void }) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients'), [models]);
  const allClients = clientsModel ? (records[clientsModel.id] ?? []) : [];
  // Picker respects view scope — a sales rep limited to "clients I created"
  // only searches their own clients, same as the records table + lookup picker.
  const clients = useApplyViewScope(clientsModel, allClients);

  const slugs = useMemo(() => resolveClientSlugs(clientsModel), [clientsModel]);

  // Same expanded-field set the table view offers as search scopes (local
  // fields + mirrored children), so "Search a specific field" lists exactly
  // the fields a user would expect — Client Code, Client Name, Phone, etc.
  const expandedFields = useMemo<ExpandedField[]>(
    () => (clientsModel ? collectViewFields(clientsModel, models) : []),
    [clientsModel, models],
  );

  const [scope, setScope] = useState<string>('all');
  const [query, setQuery] = useState('');

  // Per-client searchable text, built once per data/scope change (NOT per
  // keystroke — resolving lookups/mirrors is O(linked rows)). Mirrors the
  // RecordListPage search index exactly.
  const searchIndex = useMemo(() => {
    const idx = new Map<string, string>();
    if (!clientsModel) return idx;
    const ctx = { models, records };
    const scopedField =
      scope === 'all' ? null : expandedFields.find((f) => f.id === scope) ?? null;
    for (const rec of clients) {
      const text = scopedField
        ? buildExpandedFieldSearchText(scopedField, rec, clientsModel, ctx)
        : buildRecordSearchText(rec, clientsModel, ctx);
      idx.set(rec.id, normalizeForSearch(text));
    }
    return idx;
  }, [clients, clientsModel, models, records, scope, expandedFields]);

  const LIMIT = 30;
  const { results, total } = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    const matched = q ? clients.filter((r) => (searchIndex.get(r.id) ?? '').includes(q)) : clients;
    return { results: matched.slice(0, LIMIT), total: matched.length };
  }, [query, clients, searchIndex]);

  const toPicked = (rec: AppRecord): PickedClient => recordToPickedClient(rec, slugs, isAr);

  if (!clientsModel) {
    return (
      <div className="text-sm text-charcoal/50 py-3 text-center">
        {isAr ? 'نموذج العملاء غير متوفر' : 'Clients model not available'}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Scope selector + query — same pairing as the table view search. */}
      <div className="flex items-center gap-2">
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value)}
          className="form-input text-sm w-auto max-w-[10rem] shrink-0"
          title={isAr ? 'نطاق البحث' : 'Search scope'}
          aria-label={isAr ? 'نطاق البحث' : 'Search scope'}
        >
          <option value="all">{isAr ? 'كل الحقول' : 'All fields'}</option>
          {expandedFields.map((ef) => (
            <option key={ef.id} value={ef.id}>
              {(isAr ? ef.field.label_ar : ef.field.label_en) +
                (ef.kind === 'mirrored' ? (isAr ? ' (مرآة)' : ' (mirror)') : '')}
            </option>
          ))}
        </select>
        <div className="relative flex-1 min-w-0">
          <Search size={14} className="absolute start-3 top-1/2 -translate-y-1/2 text-charcoal/30" />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={isAr ? 'ابحث عن عميل…' : 'Search clients…'}
            className="form-input ps-8 text-sm"
            autoFocus
            dir="auto"
          />
        </div>
      </div>

      {/* Results — inline scrollable list. */}
      <div className="border border-sand/40 rounded-lg max-h-64 overflow-y-auto divide-y divide-sand/20">
        {results.length === 0 ? (
          <div className="px-3 py-6 text-sm text-charcoal/40 text-center">
            {clients.length === 0
              ? isAr
                ? 'لا يوجد عملاء بعد'
                : 'No clients yet'
              : isAr
                ? 'لا توجد نتائج'
                : 'No matches'}
          </div>
        ) : (
          results.map((rec) => {
            const c = toPicked(rec);
            return (
              <button
                key={rec.id}
                type="button"
                onClick={() => onPick(c)}
                className="w-full px-3 py-2 text-start hover:bg-cream transition-colors flex items-center gap-2.5"
              >
                <div className="w-8 h-8 rounded-full bg-copper/10 text-copper flex items-center justify-center shrink-0">
                  <User size={15} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    {c.code && (
                      <span className="font-mono font-bold text-copper text-xs" dir="ltr">
                        {c.code}
                      </span>
                    )}
                    <span className="font-semibold text-sm text-charcoal truncate">{c.name}</span>
                  </div>
                  <div className="text-xs text-charcoal/55 font-mono mt-0.5" dir="ltr">
                    {c.phone ?? (isAr ? 'لا يوجد رقم' : 'no phone')}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>

      {total > results.length && (
        <p className="text-[11px] text-charcoal/40 text-center">
          {isAr
            ? `عرض ${results.length} من ${total} — حسّن البحث لتضييق النتائج`
            : `Showing ${results.length} of ${total} — refine your search to narrow results`}
        </p>
      )}
    </div>
  );
}
