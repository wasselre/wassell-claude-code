import { useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  ClipboardList,
  FilePlus,
  FileSignature,
  Loader2,
  Megaphone,
  Presentation,
  ScrollText,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { FileRow } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { createDocument } from '@/lib/documents/client';
import { renderDocumentHtml } from '@/lib/documents/render';
import {
  DOCUMENT_TEMPLATES,
  buildTemplateContent,
  type DocumentTemplate,
  type DocumentTemplateId,
} from '@/lib/documents/templates';

const TEMPLATE_ICONS: Record<DocumentTemplateId, LucideIcon> = {
  proposal: FileSignature,
  contract: ScrollText,
  marketing_brief: Megaphone,
  meeting_notes: ClipboardList,
  property_report: Building2,
  project_presentation: Presentation,
};

interface Props {
  open: boolean;
  /** Folder the new document is created in (current Files location). */
  folderId: string | null;
  onClose: () => void;
  /** Called with the created files row — parent navigates to the editor. */
  onCreated: (file: FileRow) => void;
}

/**
 * Template picker shown by the Files header's "New Document" button.
 * "Blank" first, then the six business templates. Picking one provisions the
 * wassel_doc with the template's TipTap JSON (and pre-rendered HTML so
 * share/export paths are correct before the first autosave).
 */
export default function NewDocumentModal({ open, folderId, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  /** Template id mid-create — drives the per-card spinner + disables the rest. */
  const [busyId, setBusyId] = useState<string | null>(null);

  if (!open) return null;

  const create = async (template: DocumentTemplate | null) => {
    if (busyId) return;
    setBusyId(template?.id ?? 'blank');
    try {
      let row: FileRow;
      if (template) {
        const json = buildTemplateContent(template, isAr);
        row = await createDocument({
          title: isAr ? template.labelAr : template.labelEn,
          folderId,
          contentJson: json as Record<string, unknown>,
          contentHtml: renderDocumentHtml(json),
        });
      } else {
        row = await createDocument({
          title: isAr ? 'مستند بدون عنوان' : 'Untitled document',
          folderId,
        });
      }
      onCreated(row);
    } catch {
      /* createDocument already surfaced the error via toast */
    } finally {
      setBusyId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-charcoal/40 backdrop-blur-sm flex items-center justify-center p-4"
      onClick={() => !busyId && onClose()}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[85vh] overflow-y-auto"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4 border-b border-sand/30 sticky top-0 bg-white rounded-t-2xl">
          <div>
            <h3 className="font-bold text-charcoal text-lg">{t('files.new_doc.modal_title')}</h3>
            <p className="text-sm text-charcoal/50 mt-0.5">{t('files.new_doc.modal_subtitle')}</p>
          </div>
          <button
            onClick={onClose}
            disabled={!!busyId}
            className="p-2 rounded-lg text-charcoal/50 hover:text-charcoal hover:bg-cream disabled:opacity-40"
            aria-label={t('common.close')}
          >
            <X size={18} />
          </button>
        </div>

        {/* Template grid */}
        <div className="p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {/* Blank document — always first */}
          <TemplateCard
            icon={FilePlus}
            label={t('files.new_doc.blank')}
            description={t('files.new_doc.blank_desc')}
            busy={busyId === 'blank'}
            disabled={!!busyId}
            accent
            onClick={() => void create(null)}
          />
          {DOCUMENT_TEMPLATES.map((tpl) => (
            <TemplateCard
              key={tpl.id}
              icon={TEMPLATE_ICONS[tpl.id]}
              label={isAr ? tpl.labelAr : tpl.labelEn}
              description={isAr ? tpl.descAr : tpl.descEn}
              busy={busyId === tpl.id}
              disabled={!!busyId}
              onClick={() => void create(tpl)}
            />
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}

interface CardProps {
  icon: LucideIcon;
  label: string;
  description: string;
  busy: boolean;
  disabled: boolean;
  /** Copper-tinted card for the blank option so it reads as the default. */
  accent?: boolean;
  onClick: () => void;
}

function TemplateCard({ icon: Icon, label, description, busy, disabled, accent, onClick }: CardProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`text-start p-4 rounded-xl border transition-all flex flex-col gap-2 ${
        accent
          ? 'border-copper/40 bg-copper/5 hover:bg-copper/10 hover:border-copper/60'
          : 'border-sand/40 bg-white hover:bg-cream hover:border-copper/30'
      } ${disabled && !busy ? 'opacity-50' : ''}`}
    >
      <div className="flex items-center justify-between">
        <div
          className={`w-10 h-10 rounded-xl flex items-center justify-center ${
            accent ? 'bg-copper/15 text-copper' : 'bg-cream text-charcoal/60'
          }`}
        >
          {busy ? <Loader2 size={20} className="animate-spin text-copper" /> : <Icon size={20} />}
        </div>
      </div>
      <div className="font-bold text-charcoal text-sm">{label}</div>
      <div className="text-xs text-charcoal/50 leading-relaxed">{description}</div>
    </button>
  );
}
