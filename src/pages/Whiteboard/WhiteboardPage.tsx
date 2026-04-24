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
 * License: tldraw enforces its license in production by unmounting the
 * editor after 5 seconds on any non-localhost hostname when the license
 * state is `unlicensed-production` (see @tldraw/editor LicenseProvider
 * — LICENSE_TIMEOUT + shouldHideEditorAfterDelay). We pass the key via
 * the `VITE_TLDRAW_LICENSE_KEY` build-time env var so it gets inlined
 * at `vite build` time and never lives in source. Localhost is always
 * treated as development, so an empty key is fine for local dev.
 */
export default function WhiteboardPage(): JSX.Element {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language) === 'ar';
  const licenseKey = import.meta.env.VITE_TLDRAW_LICENSE_KEY as string | undefined;

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
        <Tldraw persistenceKey="wassel-whiteboard-v1" licenseKey={licenseKey} />
      </div>
    </div>
  );
}
