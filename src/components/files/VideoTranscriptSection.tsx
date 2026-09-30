import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlignLeft, Loader2, Maximize2 } from 'lucide-react';
import { fetchVideoTranscripts, type VideoTranscript } from '@/lib/files/transcripts';
import TranscriptModal from './TranscriptModal';

/**
 * A video file's spoken-word transcript, inline: a short scrollable excerpt
 * with an "expand" that opens the full reader. Loads its own transcript (one
 * file), and says so plainly when there is none or when loading failed — three
 * different states that must never look the same.
 */
interface Props {
  fileId: string;
  title: string;
  durationSeconds?: number | null;
  description?: string | null;
  /** `dark` sits on the full-screen preview's black backdrop. */
  tone?: 'light' | 'dark';
}

type State =
  | { status: 'loading' }
  | { status: 'ready'; transcript: VideoTranscript | null }
  | { status: 'error' };

export default function VideoTranscriptSection({ fileId, title, durationSeconds, description, tone = 'light' }: Props) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: 'loading' });
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    setOpen(false);
    fetchVideoTranscripts([fileId])
      .then((m) => { if (!cancelled) setState({ status: 'ready', transcript: m[fileId] ?? null }); })
      .catch((e) => {
        console.error('[VideoTranscriptSection] transcript failed to load', e);
        if (!cancelled) setState({ status: 'error' });
      });
    return () => { cancelled = true; };
  }, [fileId]);

  const dark = tone === 'dark';
  const labelCls = dark ? 'text-white/60' : 'text-charcoal/50';
  const mutedCls = dark ? 'text-white/50' : 'text-charcoal/45';
  const boxCls = dark ? 'bg-white/10 text-white/85' : 'bg-cream/40 text-charcoal/75';

  return (
    <div>
      <div className={`mb-1 flex items-center gap-1 text-[11px] font-bold ${labelCls}`}>
        <AlignLeft size={11} aria-hidden />
        {t('files.transcript.title')}
        {state.status === 'ready' && state.transcript && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className={`ms-auto inline-flex items-center gap-1 font-medium ${dark ? 'text-white/80 hover:text-white' : 'text-copper hover:text-terracotta'}`}
          >
            <Maximize2 size={10} aria-hidden />
            {t('files.transcript.button')}
          </button>
        )}
      </div>
      {state.status === 'loading' ? (
        <p className={`flex items-center gap-1.5 text-xs ${mutedCls}`}>
          <Loader2 size={12} className="animate-spin" aria-hidden /> {t('files.transcript.loading')}
        </p>
      ) : state.status === 'error' ? (
        <p className="text-xs text-red-600">{t('files.transcript.load_failed')}</p>
      ) : state.transcript ? (
        <p className={`max-h-32 overflow-y-auto whitespace-pre-wrap rounded-lg p-2 text-xs leading-relaxed ${boxCls}`} dir="auto">
          {state.transcript.text}
        </p>
      ) : (
        <p className={`text-xs ${mutedCls}`}>{t('files.transcript.none')}</p>
      )}
      {open && state.status === 'ready' && state.transcript && (
        <TranscriptModal
          title={title}
          text={state.transcript.text}
          durationSeconds={durationSeconds}
          description={description}
          onClose={() => setOpen(false)}
        />
      )}
    </div>
  );
}
