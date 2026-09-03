import { MessageSquare, Phone } from 'lucide-react';
import type { EvidenceView } from '../lib/types';

/**
 * The source evidence behind a proposal: each mention's exact quoted span with
 * its geographic anchors highlighted, plus the channel/role/applicability the AI
 * read. This is the reviewer's ground truth — what the customer actually said.
 */
export default function EvidencePanel({ evidence, isAr }: { evidence: EvidenceView[]; isAr: boolean }) {
  if (!evidence.length) {
    return (
      <p className="text-sm text-charcoal/50">
        {isAr ? 'لا توجد أدلة مصدرية مرتبطة بهذا الاقتراح.' : 'No source evidence linked to this proposal.'}
      </p>
    );
  }
  return (
    <div className="space-y-3">
      {evidence.map((e) => (
        <div key={e.id} className="rounded-xl border border-sand/30 bg-cream/40 p-4">
          <div className="mb-2 flex items-center gap-2 text-xs text-charcoal/50">
            {e.channel === 'call' ? <Phone size={13} /> : <MessageSquare size={13} />}
            <span>{e.channel === 'call' ? (isAr ? 'مكالمة' : 'Call') : (isAr ? 'محادثة' : 'Chat')}</span>
            {e.timestamp && <span>· {new Date(e.timestamp).toLocaleString(isAr ? 'ar' : 'en')}</span>}
          </div>
          <blockquote className="border-s-2 border-copper/50 ps-3 text-sm text-charcoal leading-relaxed">
            “{e.mention_span}”
          </blockquote>
          {e.anchors.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {e.anchors.map((a, i) => (
                <span key={i} className="rounded-md bg-gold/15 px-2 py-0.5 text-xs font-bold text-terracotta">
                  {a.span || a.normalized_token}
                  {a.anchor_type ? <span className="font-normal text-charcoal/40"> · {a.anchor_type}</span> : null}
                </span>
              ))}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-2 text-[11px] text-charcoal/45">
            {e.preference_role && <span>{isAr ? 'الاتجاه' : 'role'}: {e.preference_role}</span>}
            {e.holder_role && <span>{isAr ? 'صاحب التفضيل' : 'holder'}: {e.holder_role}</span>}
            {e.applicability && <span>{isAr ? 'الحالة' : 'applicability'}: {e.applicability}</span>}
          </div>
        </div>
      ))}
    </div>
  );
}
