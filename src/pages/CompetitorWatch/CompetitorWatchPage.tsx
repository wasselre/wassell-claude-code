/**
 * Competitor Watch (مرصد المنافسين) — a NEW, self-contained workspace, built
 * from scratch (deliberately NOT on the old Marketing Intelligence page).
 *
 * v1 ships one surface: the Content Library ("the shelves") — every piece of
 * competitor content the enrichment AI has read, on labeled, searchable shelves.
 * The four monitoring surfaces (Agents / Pipeline / Storage / Companies) are
 * stubbed in the sub-nav as "soon" and land in the next batch.
 */
import { useAppStore } from '@/stores/appStore';
import ContentLibrary from './components/ContentLibrary';
import './watch.css';

type Surface = 'library' | 'agents' | 'pipeline' | 'storage' | 'companies';

export default function CompetitorWatchPage() {
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const surface: Surface = 'library';

  const NAV: Array<{ id: Surface; ar: string; en: string; soon?: boolean }> = [
    { id: 'library', ar: 'مكتبة المحتوى', en: 'Content library' },
    { id: 'agents', ar: 'الوكلاء والتشغيل', en: 'Agents & runs', soon: true },
    { id: 'pipeline', ar: 'مسار المحتوى', en: 'Content pipeline', soon: true },
    { id: 'storage', ar: 'التخزين', en: 'Storage', soon: true },
    { id: 'companies', ar: 'الشركات', en: 'Companies', soon: true },
  ];

  return (
    <div className="cw-root">
      <div className="cw-cbar">
        <div className="cw-brand">
          <span className="cw-mark">{isAr ? 'مرصد المنافسين' : 'Competitor Watch'}</span>
          <span className="cw-sub">
            {isAr ? 'ماذا يسوّق المنافسون، وأين، وبأي رسالة' : 'What competitors market, where, and with what message'}
          </span>
        </div>
      </div>

      <nav className="cw-nav">
        {NAV.map((n) => (
          <button
            key={n.id}
            type="button"
            className={`cw-navbtn${surface === n.id ? ' on' : ''}${n.soon ? ' soon' : ''}`}
            disabled={n.soon}
          >
            {isAr ? n.ar : n.en}
            {n.soon && <span className="cw-soon">{isAr ? 'قريباً' : 'soon'}</span>}
          </button>
        ))}
      </nav>

      {surface === 'library' && <ContentLibrary isAr={isAr} />}
    </div>
  );
}
