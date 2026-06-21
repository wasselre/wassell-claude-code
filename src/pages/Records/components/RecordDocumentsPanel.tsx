import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Download, Eye, FilePlus2, FileText, Loader2, RefreshCw, Send } from 'lucide-react';
import Button from '@/components/ui/Button';
import { useAppStore } from '@/stores/appStore';
import { formatBytes } from '@/lib/files/format';
import { signDownloadUrl } from '@/lib/files/client';
import {
  enqueueGenerateDocument,
  listGeneratedDocuments,
  pollDocumentJob,
  type GeneratedDocument,
} from '@/lib/documents/generate';
import { listTemplatesForModel, type DocumentTemplateBinding } from '@/lib/documents/templateRegistry';
import SendDocumentModal from './SendDocumentModal';

interface Props {
  modelId: string;
  recordId: string;
}

const POLL_MS = 2500;
const TIMEOUT_MS = 180_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * "Generate documents" panel on a record form. Appears only when the record's
 * model has ≥1 bound document template (or already has generated PDFs), so
 * models without templates are visually unchanged. Generate → poll → preview /
 * download / send-to-customer. Mirrors LinkedDocumentsPanel's self-hide + card
 * shell and the office-preview poll/failure-card pattern.
 */
export default function RecordDocumentsPanel({ modelId, recordId }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [templates, setTemplates] = useState<DocumentTemplateBinding[]>([]);
  const [docs, setDocs] = useState<GeneratedDocument[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const [showPicker, setShowPicker] = useState(false);
  const [sendTarget, setSendTarget] = useState<{ fileId: string; fileName: string } | null>(null);
  const genTokenRef = useRef(0);

  const refreshDocs = async () => {
    try {
      setDocs(await listGeneratedDocuments(recordId));
    } catch {
      /* surfaced by the service */
    }
  };

  useEffect(() => {
    let cancelled = false;
    Promise.all([listTemplatesForModel(modelId), listGeneratedDocuments(recordId)])
      .then(([tpls, generated]) => {
        if (cancelled) return;
        setTemplates(tpls);
        setDocs(generated);
      })
      .catch(() => {
        /* surfaced by the services */
      })
      .finally(() => {
        if (!cancelled) setLoaded(true);
      });
    return () => {
      cancelled = true;
      // Stop any in-flight poll loop on unmount.
      genTokenRef.current += 1;
    };
  }, [modelId, recordId]);

  const runGenerate = async (tmpl: DocumentTemplateBinding) => {
    const token = (genTokenRef.current += 1);
    setShowPicker(false);
    setGenerating(true);
    setGenError(null);
    try {
      const { jobId } = await enqueueGenerateDocument({ recordId, modelId, templateId: tmpl.id });
      const deadline = Date.now() + TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_MS);
        if (genTokenRef.current !== token) return; // superseded / unmounted
        const st = await pollDocumentJob(jobId);
        if (genTokenRef.current !== token) return;
        if (st.status === 'ready') {
          await refreshDocs();
          addToast(t('doc.gen.success'), 'success');
          setGenerating(false);
          return;
        }
        if (st.status === 'failed') {
          setGenError(st.error);
          setGenerating(false);
          return;
        }
      }
      setGenError(t('doc.gen.timeout'));
      setGenerating(false);
    } catch (err) {
      if (genTokenRef.current !== token) return;
      setGenError(err instanceof Error ? err.message : String(err));
      setGenerating(false);
    }
  };

  const onGenerateClick = () => {
    if (templates.length === 1) void runGenerate(templates[0]!);
    else setShowPicker((v) => !v);
  };

  const download = async (fileId: string) => {
    try {
      const { url } = await signDownloadUrl(fileId);
      window.open(url, '_blank', 'noopener');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  // Self-hide: nothing to offer and nothing generated → render nothing.
  if (!loaded || (templates.length === 0 && docs.length === 0)) return null;

  return (
    <div className="mt-6 bg-white rounded-2xl border border-sand/30 p-5">
      <div className="flex items-center justify-between gap-2 mb-3">
        <div className="flex items-center gap-2">
          <FileText size={16} className="text-copper" />
          <h3 className="font-bold text-charcoal text-sm">{t('doc.gen.panel_title')}</h3>
        </div>
        {templates.length > 0 && (
          <div className="relative">
            <Button variant="primary" onClick={onGenerateClick} disabled={generating}>
              {generating ? <Loader2 size={16} className="animate-spin" /> : <FilePlus2 size={16} />}
              {generating ? t('doc.gen.generating') : t('doc.gen.generate')}
            </Button>
            {showPicker && templates.length > 1 && (
              <div className="absolute z-10 mt-1 end-0 w-64 bg-white rounded-xl border border-sand/40 shadow-lg p-1">
                <div className="px-3 py-1.5 text-xs font-bold text-charcoal/40">{t('doc.gen.pick_template')}</div>
                {templates.map((tpl) => (
                  <button
                    key={tpl.id}
                    onClick={() => void runGenerate(tpl)}
                    className="w-full text-start px-3 py-2 rounded-lg hover:bg-cream text-sm text-charcoal flex items-center gap-2"
                  >
                    <FileText size={14} className="text-copper shrink-0" />
                    <span className="truncate">{isAr ? tpl.label_ar : tpl.label_en}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Failure card — never a dead spinner. */}
      {genError && (
        <div className="flex items-start gap-2 bg-red-50 text-red-700 rounded-xl px-3 py-2.5 text-sm mb-3">
          <AlertCircle size={16} className="shrink-0 mt-0.5" />
          <div className="flex-1 min-w-0">
            <div className="font-bold">{t('doc.gen.failed')}</div>
            <div className="text-red-600/80 break-words">{genError}</div>
          </div>
          {templates.length > 0 && (
            <button
              onClick={() => void runGenerate(templates[0]!)}
              className="shrink-0 inline-flex items-center gap-1 text-xs font-bold text-red-700 hover:underline"
            >
              <RefreshCw size={13} />
              {t('doc.gen.retry')}
            </button>
          )}
        </div>
      )}

      {docs.length === 0 ? (
        <p className="text-sm text-charcoal/40">{t('doc.gen.none_yet')}</p>
      ) : (
        <div className="space-y-2">
          {docs.map((d) => (
            <div
              key={d.fileId}
              className="flex items-center gap-2.5 px-3 py-2.5 rounded-xl border border-sand/30 hover:border-copper/30 transition-colors"
            >
              <FileText size={16} className="text-copper shrink-0" />
              <div className="flex-1 min-w-0">
                <div className="text-sm font-bold text-charcoal truncate" title={d.name}>
                  {d.name}
                </div>
                <div className="text-[0.6875rem] text-charcoal/40">{formatBytes(d.sizeBytes, isAr)}</div>
              </div>
              <a
                href={d.url}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 p-2 rounded-lg hover:bg-cream text-charcoal/60 hover:text-copper"
                title={t('doc.gen.preview')}
              >
                <Eye size={16} />
              </a>
              <button
                onClick={() => void download(d.fileId)}
                className="shrink-0 p-2 rounded-lg hover:bg-cream text-charcoal/60 hover:text-copper"
                title={t('doc.gen.download')}
              >
                <Download size={16} />
              </button>
              <button
                onClick={() => setSendTarget({ fileId: d.fileId, fileName: d.name })}
                className="shrink-0 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-copper/10 text-copper hover:bg-copper/20 text-xs font-bold"
              >
                <Send size={14} />
                {t('doc.send.action')}
              </button>
            </div>
          ))}
        </div>
      )}

      {sendTarget && (
        <SendDocumentModal
          open
          onClose={() => setSendTarget(null)}
          fileId={sendTarget.fileId}
          fileName={sendTarget.fileName}
          modelId={modelId}
          recordId={recordId}
        />
      )}
    </div>
  );
}
