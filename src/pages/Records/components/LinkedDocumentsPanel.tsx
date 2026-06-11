import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { FileEdit, Link2 } from 'lucide-react';
import type { FileRow } from '@/types';
import { useAppStore } from '@/stores/appStore';
import { listLinksForRecord } from '@/lib/documents/links';
import { listFilesByIds, signDownloadUrl } from '@/lib/files/client';
import { formatBytes, kindIcon } from '@/lib/files/format';

interface Props {
  modelId: string;
  recordId: string;
}

/**
 * "Linked documents" section on a record form — documents (and files) that
 * were related to this record via the document↔record links feature. Renders
 * NOTHING when the record has no links, so models without documents stay
 * visually unchanged. RLS already filtered the list to files the caller can
 * open. Wassel docs open in the editor; other kinds download.
 */
export default function LinkedDocumentsPanel({ modelId, recordId }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);
  const navigate = useNavigate();
  const [files, setFiles] = useState<FileRow[]>([]);

  useEffect(() => {
    let cancelled = false;
    listLinksForRecord(modelId, recordId)
      .then(async (links) => {
        if (cancelled || links.length === 0) {
          if (!cancelled) setFiles([]);
          return;
        }
        const rows = await listFilesByIds(links.map((l) => l.file_id));
        if (!cancelled) setFiles(rows);
      })
      .catch(() => {
        /* surfaced by the links/files clients */
      });
    return () => {
      cancelled = true;
    };
  }, [modelId, recordId]);

  if (files.length === 0) return null;

  const open = async (f: FileRow) => {
    if (f.kind === 'wassel_doc') {
      navigate(`/files/doc/${f.id}`);
      return;
    }
    try {
      const { url } = await signDownloadUrl(f.id);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center gap-2 mb-3">
        <Link2 size={16} className="text-copper" />
        <h3 className="font-bold text-charcoal text-sm">{t('doc.links.record_panel_title')}</h3>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {files.map((f) => {
          const Icon = f.kind === 'wassel_doc' ? FileEdit : kindIcon[f.kind];
          return (
            <button
              key={f.id}
              onClick={() => void open(f)}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-sand/30 hover:bg-cream hover:border-copper/30 text-start transition-colors"
            >
              <Icon size={16} className="text-copper shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-charcoal truncate" title={f.original_name}>
                  {f.original_name}
                </div>
                <div className="text-[0.6875rem] text-charcoal/40">
                  {f.kind === 'wassel_doc' ? t('doc.links.wassel_doc') : formatBytes(f.size_bytes, isAr)}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
