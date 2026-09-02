/**
 * VersionsBar — every creative package version for this content item, newest
 * first. A version is the auditable unit: AI generations and human saves each
 * land as their own row (the server mints a new version on every save), so the
 * bar is the "what changed, when, by whom" strip above the editor.
 */
import type { CreativePackageRow } from '@/lib/creative/contracts';
import { num, shortDate } from '../../lib/format';
import { PACKAGE_STATUS_LABELS, pick } from './labels';

export default function VersionsBar({
  packages, activeId, isAr, onSelect,
}: {
  packages: CreativePackageRow[];
  activeId: string | null;
  isAr: boolean;
  onSelect: (packageId: string) => void;
}) {
  if (packages.length === 0) return null;
  const sorted = [...packages].sort((a, b) => b.version - a.version);
  return (
    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
      <span className="lbl" style={{ marginInlineEnd: 2 }}>
        {isAr ? 'النسخ' : 'Versions'}
      </span>
      {sorted.map((p) => {
        const on = p.id === activeId;
        return (
          <button
            key={p.id}
            type="button"
            className={`fbtn${on ? ' on' : ''}`}
            title={`${shortDate(p.created_at, isAr)} · ${pick(PACKAGE_STATUS_LABELS, p.status, isAr)}`}
            onClick={() => onSelect(p.id)}
          >
            {isAr ? `ن${num(p.version, true)}` : `v${p.version}`}
            {' · '}
            {p.generated_by === 'human' ? (isAr ? 'يدوي' : 'human') : (isAr ? 'ذكاء' : 'AI')}
            {p.stage === 'concepts' ? (isAr ? ' · أفكار' : ' · concepts') : ''}
            {p.status === 'applied' ? (isAr ? ' · مُطبَّقة' : ' · applied') : ''}
          </button>
        );
      })}
    </div>
  );
}
