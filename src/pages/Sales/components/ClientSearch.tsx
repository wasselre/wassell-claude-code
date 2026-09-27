/**
 * Client search for the Sales Workspace Tools menu.
 *
 * Matches a client by NAME or PHONE. The lookup picker (LookupCombobox) only
 * matches the display name, but reps usually have the number in hand, so this
 * searches every phone field too. Both sides go through `normalizeForSearch`
 * (Arabic letter folding + Arabic-Indic digits → Latin), and phone matching
 * compares digits with the Saudi prefix removed (see `nationalDigits`), so
 * "0501234567", "+966 50 123 4567", "501234567" and "٠٥٠١٢٣٤٥٦٧" all find
 * the same client.
 *
 * Reads the clients already in the store, which are RLS-scoped — a rep only
 * finds the clients they are allowed to see.
 */
import { useMemo, useState } from 'react';
import { Search, User as UserIcon } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';
import { normalizeForSearch } from '@/lib/recordSearch';
import { phoneFieldSlugs } from '@/lib/haberchat/normalize';
import type { AppRecord } from '@/types';

/** Results rendered at once. Past this the list says how many matched and asks
 *  for a narrower query — never a silent cut. */
const SHOW_LIMIT = 50;

/**
 * Digits with a leading Saudi prefix removed (`00`, `966`, local trunk `0`), on
 * BOTH sides of the compare. Stored numbers come as `+966…`, `05…` or the bare
 * 9-digit subscriber number, and reps type any of the three — so a plain digit
 * compare would miss `0536…` against a stored `536…`. Only the leading prefix
 * is stripped (not rewritten to 966, as `ksaCanonicalPhone` does), so a stored
 * non-Saudi number like `9715…` is left intact and still matches by digits.
 */
const nationalDigits = (s: string): string => {
  let d = normalizeForSearch(s).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('966')) return d.slice(3);
  if (d.startsWith('0')) return d.slice(1);
  return d;
};

export interface PickedToolClient {
  id: string;
  name: string;
  phone: string | null;
}

interface ClientSearchProps {
  onPick: (client: PickedToolClient) => void;
}

export default function ClientSearch({ onPick }: ClientSearchProps) {
  const models = useAppStore((s) => s.models);
  const records = useAppStore((s) => s.records);
  const isAr = useAppStore((s) => s.language) === 'ar';
  const [query, setQuery] = useState('');

  const clientsModel = useMemo(() => models.find((m) => m.name === 'clients') ?? null, [models]);
  const phoneSlugs = useMemo(() => phoneFieldSlugs(clientsModel), [clientsModel]);
  const clients: AppRecord[] = clientsModel ? (records[clientsModel.id] ?? []) : [];

  const toPicked = (r: AppRecord): PickedToolClient => {
    const d = r.data as Record<string, unknown>;
    const phone = phoneSlugs.map((s) => d[s]).find((v): v is string => typeof v === 'string' && v.trim() !== '') ?? null;
    return { id: r.id, name: typeof d.client_name === 'string' ? d.client_name : '', phone };
  };

  const matches = useMemo(() => {
    const q = normalizeForSearch(query.trim());
    if (!q) return [];
    const qDigits = nationalDigits(query);
    return clients.filter((r) => {
      const d = r.data as Record<string, unknown>;
      const name = typeof d.client_name === 'string' ? normalizeForSearch(d.client_name) : '';
      if (name.includes(q)) return true;
      if (qDigits.length < 3) return false;
      return phoneSlugs.some((s) => typeof d[s] === 'string' && nationalDigits(d[s] as string).includes(qDigits));
    });
  }, [query, clients, phoneSlugs]);

  if (!clientsModel) {
    return <p className="text-sm text-charcoal/50">{isAr ? 'نموذج العملاء غير متاح' : 'Clients model is not available'}</p>;
  }

  const shown = matches.slice(0, SHOW_LIMIT);

  return (
    <div className="space-y-2">
      <div className="relative">
        <Search size={15} className="absolute top-1/2 -translate-y-1/2 start-3 text-charcoal/40" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={isAr ? 'اكتب اسم العميل أو رقم جواله' : 'Type a client name or phone number'}
          className="w-full rounded-lg border border-sand bg-white py-2 ps-9 pe-3 text-sm focus:outline-none focus:ring-2 focus:ring-copper/30"
        />
      </div>

      {query.trim() !== '' && (
        <div className="max-h-72 overflow-y-auto rounded-lg border border-sand/60 divide-y divide-sand/40 bg-white">
          {shown.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-charcoal/50">
              {isAr ? 'لا يوجد عميل مطابق' : 'No matching client'}
            </p>
          )}
          {shown.map((r) => {
            const c = toPicked(r);
            return (
              <button
                key={r.id}
                type="button"
                onClick={() => onPick(c)}
                className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-cream"
              >
                <UserIcon size={14} className="shrink-0 text-copper" />
                <span className="flex-1 truncate font-semibold text-charcoal">
                  {c.name || (isAr ? 'عميل بلا اسم' : 'Unnamed client')}
                </span>
                {c.phone && <span className="shrink-0 text-xs text-charcoal/50" dir="ltr">{c.phone}</span>}
              </button>
            );
          })}
        </div>
      )}

      {matches.length > SHOW_LIMIT && (
        <p className="text-xs text-charcoal/60">
          {isAr
            ? `يُعرض ${SHOW_LIMIT} من ${matches.length} نتيجة — اكتب أكثر لتضييق البحث`
            : `Showing ${SHOW_LIMIT} of ${matches.length} matches — type more to narrow it down`}
        </p>
      )}
    </div>
  );
}
