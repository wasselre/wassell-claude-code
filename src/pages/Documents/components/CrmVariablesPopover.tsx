import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Braces, Link2, X } from 'lucide-react';
import type { DocVariableGroup } from '@/lib/documents/variables';

interface Props {
  open: boolean;
  groups: DocVariableGroup[];
  onInsert: (slug: string) => void;
  onClose: () => void;
  /** Opens the Linked-records modal — offered when there's nothing to insert. */
  onManageLinks: () => void;
}

/**
 * "Insert CRM variable" picker — lists every resolvable variable from the
 * document's linked records (grouped per record) with a live value preview.
 * Clicking inserts the `{{slug}}` token at the cursor; the decoration layer
 * immediately displays the resolved value.
 */
export default function CrmVariablesPopover({ open, groups, onInsert, onClose, onManageLinks }: Props) {
  const { t } = useTranslation();
  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4 modal-overlay"
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[80vh] overflow-y-auto"
      >
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-sand/30 sticky top-0 bg-white rounded-t-2xl">
          <div className="flex items-center gap-2">
            <Braces size={18} className="text-copper" />
            <h3 className="font-bold text-charcoal">{t('doc.vars.title')}</h3>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream"
            aria-label={t('common.close')}
          >
            <X size={16} />
          </button>
        </div>

        <div className="p-4">
          {groups.length === 0 ? (
            <div className="text-center py-6">
              <p className="text-sm text-charcoal/50 mb-4">{t('doc.vars.empty')}</p>
              <button
                onClick={() => {
                  onClose();
                  onManageLinks();
                }}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-copper text-white hover:bg-terracotta font-bold text-sm transition-colors"
              >
                <Link2 size={14} />
                {t('doc.links.title')}
              </button>
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((g) => (
                <div key={g.linkId}>
                  <div className="text-xs font-bold text-charcoal/40 uppercase tracking-widest mb-1.5">
                    {g.recordTitle} <span className="font-normal normal-case">· {g.modelLabel}</span>
                  </div>
                  <div className="space-y-0.5">
                    {g.variables.map((v) => (
                      <button
                        key={`${g.linkId}:${v.slug}`}
                        onClick={() => onInsert(v.slug)}
                        className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg hover:bg-cream text-start group"
                        title={`{{${v.slug}}}`}
                      >
                        <span className="text-sm font-bold text-charcoal shrink-0">{v.label}</span>
                        <span className="text-xs text-charcoal/40 truncate flex-1">{v.value}</span>
                        <span className="text-[0.625rem] text-copper opacity-0 group-hover:opacity-100 font-mono shrink-0" dir="ltr">
                          {'{{'}{v.slug}{'}}'}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
