import { Trash2, ArrowLeftRight } from 'lucide-react';
import { describeClause, cloneExpression } from '../lib/describe';
import type { GeoPreferenceDTO } from '../lib/types';

/**
 * Lightweight structural editor over the compiled expression. The reviewer can
 * flip a clause include↔exclude or drop a clause/group before applying — this
 * produces the `finalExpression` the `edit` action persists and applies. It does
 * NOT re-interpret anchors (the server owns the authoritative mapping); it only
 * prunes and re-polarises the tree the AI compiled.
 */
export default function ExpressionEditor({
  working,
  onChange,
  isAr,
}: {
  working: GeoPreferenceDTO;
  onChange: (next: GeoPreferenceDTO) => void;
  isAr: boolean;
}) {
  const flip = (gi: number, ci: number) => {
    const next = cloneExpression(working);
    const clause = next.groups[gi]?.clauses[ci];
    if (!clause) return;
    clause.op = clause.op === 'exclude' ? 'include' : 'exclude';
    onChange(next);
  };
  const removeClause = (gi: number, ci: number) => {
    const next = cloneExpression(working);
    const group = next.groups[gi];
    if (!group) return;
    group.clauses.splice(ci, 1);
    if (group.clauses.length === 0) next.groups.splice(gi, 1);
    onChange(next);
  };

  if (!working.groups?.length) {
    return (
      <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-700">
        {isAr ? 'لم يتبقَّ أي معيار — لا يمكن تطبيق تعبير فارغ.' : 'No rules left — an empty expression cannot be applied.'}
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {working.groups.map((g, gi) => (
        <div key={g.id ?? gi} className="rounded-xl border border-sand/30 p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] uppercase tracking-wide text-charcoal/40">
            <span>{isAr ? 'مجموعة' : 'Group'} {gi + 1}</span>
            <span>· {g.role}</span>
            <span>· {g.strength}</span>
          </div>
          <div className="space-y-1.5">
            {g.clauses.map((c, ci) => {
              const d = describeClause(c, isAr);
              const exclude = d.op === 'exclude';
              return (
                <div key={ci} className="flex items-center justify-between gap-2 rounded-lg bg-cream/50 px-2.5 py-1.5">
                  <span className="min-w-0 flex-1 truncate text-xs">
                    <span className={`me-1.5 rounded px-1.5 py-0.5 text-[10px] font-bold ${exclude ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}`}>
                      {exclude ? (isAr ? 'استثناء' : 'EXCLUDE') : (isAr ? 'تضمين' : 'INCLUDE')}
                    </span>
                    {d.parts.join(isAr ? ' أو ' : ' or ') || (isAr ? 'غير محدد' : 'unresolved')}
                  </span>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      type="button"
                      onClick={() => flip(gi, ci)}
                      title={isAr ? 'قلب التضمين/الاستثناء' : 'Flip include/exclude'}
                      className="rounded-md p-1 text-charcoal/50 hover:bg-sand/20 hover:text-charcoal"
                    >
                      <ArrowLeftRight size={14} />
                    </button>
                    <button
                      type="button"
                      onClick={() => removeClause(gi, ci)}
                      title={isAr ? 'حذف' : 'Remove'}
                      className="rounded-md p-1 text-charcoal/50 hover:bg-red-50 hover:text-red-500"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
