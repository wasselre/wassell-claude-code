import { useTranslation } from 'react-i18next';
import { Tldraw } from 'tldraw';
import 'tldraw/tldraw.css';
import { useAppStore } from '@/stores/appStore';

/**
 * Whiteboard — full-bleed tldraw canvas.
 *
 * Persistence: tldraw's built-in `persistenceKey` auto-saves the document
 * to the browser's IndexedDB under the given key. One shared board per
 * browser profile; nothing is synced to Supabase yet.
 *
 * RTL: tldraw's UI chrome is LTR-only, so we wrap the canvas in an
 * explicit `dir="ltr"` container regardless of app language. Arabic
 * labels in our own page header still follow the app direction.
 *
 * License: tldraw's default terms allow development use only. Before
 * this is exposed to customers in production we must either (a) pay
 * for a commercial license key and pass it to <Tldraw licenseKey=...>,
 * or (b) accept the "Made with tldraw" watermark on the hobby license.
 */
export default function WhiteboardPage(): JSX.Element {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language) === 'ar';

  return (
    <div>
      <div className="mb-4">
        <h1 className="text-xl font-bold text-charcoal">
          {t('whiteboard.title')}
        </h1>
        <p className="text-sm text-charcoal/50 mt-1">
          {isAr
            ? 'لوحة رسم تفاعلية للتخطيط والتعليق على الخرائط والمخططات.'
            : 'Interactive canvas for planning, annotating maps, and sketching ideas.'}
        </p>
      </div>

      <div
        dir="ltr"
        className="relative h-[calc(100vh-10rem)] w-full rounded-2xl overflow-hidden border border-sand/40 bg-white"
      >
        <Tldraw persistenceKey="wassel-whiteboard-v1" />
      </div>
    </div>
  );
}
