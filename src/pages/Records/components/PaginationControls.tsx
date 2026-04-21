import { useTranslation } from 'react-i18next';
import { useAppStore } from '@/stores/appStore';
import { ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';

// Page-size options the user can pick from. Include the current value if it
// falls outside this list (e.g. a persisted custom size).
export const PAGE_SIZE_OPTIONS = [10, 25, 50, 100, 200];

interface PageSizeSelectorProps {
  pageSize: number;
  onChange: (size: number) => void;
}

/**
 * Compact page-size dropdown shown above the list. Updates page size and
 * lets the parent reset to page 1 as needed.
 */
export function PageSizeSelector({ pageSize, onChange }: PageSizeSelectorProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';
  const options = PAGE_SIZE_OPTIONS.includes(pageSize)
    ? PAGE_SIZE_OPTIONS
    : [...PAGE_SIZE_OPTIONS, pageSize].sort((a, b) => a - b);

  return (
    <label className="flex items-center gap-2 text-xs text-charcoal/60">
      <span className="font-bold">{isAr ? 'عدد السجلات:' : t('pagination.rows_per_page')}</span>
      <select
        value={pageSize}
        onChange={(e) => onChange(Number(e.target.value))}
        className="form-input text-xs py-1 px-2 w-auto"
      >
        {options.map((n) => (
          <option key={n} value={n}>{n}</option>
        ))}
      </select>
    </label>
  );
}

interface PageNavigatorProps {
  totalCount: number;
  currentPage: number; // 1-indexed
  pageSize: number;
  onPageChange: (page: number) => void;
}

/**
 * Bottom navigator: summary on one side, first/prev/next/last on the other.
 * Hidden entirely when there's only one page (or zero records).
 */
export function PageNavigator({ totalCount, currentPage, pageSize, onPageChange }: PageNavigatorProps) {
  const { t } = useTranslation();
  const { language } = useAppStore();
  const isAr = language === 'ar';

  if (totalCount === 0) return null;
  const totalPages = Math.max(1, Math.ceil(totalCount / pageSize));
  const safePage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (safePage - 1) * pageSize + 1;
  const end = Math.min(start + pageSize - 1, totalCount);

  if (totalPages <= 1) {
    // Still show the summary so the user knows how many records are displayed.
    return (
      <div className="flex items-center justify-center mt-3 text-xs text-charcoal/40">
        <span>{t('pagination.summary', { start, end, total: totalCount })}</span>
      </div>
    );
  }

  const canPrev = safePage > 1;
  const canNext = safePage < totalPages;
  const btnBase =
    'p-1.5 rounded-lg transition-colors disabled:opacity-30 disabled:cursor-not-allowed';
  const btnActive = 'text-charcoal/60 hover:text-copper hover:bg-copper/8';

  return (
    <div className="flex items-center justify-between mt-3 px-1">
      <div className="text-xs text-charcoal/40">
        {t('pagination.summary', { start, end, total: totalCount })}
      </div>
      <div className="flex items-center gap-1" dir="ltr">
        <button
          type="button"
          onClick={() => onPageChange(1)}
          disabled={!canPrev}
          className={`${btnBase} ${btnActive}`}
          aria-label={isAr ? 'الصفحة الأولى' : 'First page'}
          title={isAr ? 'الصفحة الأولى' : 'First page'}
        >
          <ChevronsLeft size={14} />
        </button>
        <button
          type="button"
          onClick={() => onPageChange(safePage - 1)}
          disabled={!canPrev}
          className={`${btnBase} ${btnActive}`}
          aria-label={isAr ? 'السابق' : 'Previous'}
          title={isAr ? 'السابق' : 'Previous'}
        >
          <ChevronLeft size={14} />
        </button>
        <span className="px-3 py-1 text-xs font-bold text-charcoal/70 bg-cream/50 rounded-lg min-w-[4rem] text-center">
          {t('pagination.page_of', { page: safePage, total: totalPages })}
        </span>
        <button
          type="button"
          onClick={() => onPageChange(safePage + 1)}
          disabled={!canNext}
          className={`${btnBase} ${btnActive}`}
          aria-label={isAr ? 'التالي' : 'Next'}
          title={isAr ? 'التالي' : 'Next'}
        >
          <ChevronRight size={14} />
        </button>
        <button
          type="button"
          onClick={() => onPageChange(totalPages)}
          disabled={!canNext}
          className={`${btnBase} ${btnActive}`}
          aria-label={isAr ? 'الصفحة الأخيرة' : 'Last page'}
          title={isAr ? 'الصفحة الأخيرة' : 'Last page'}
        >
          <ChevronsRight size={14} />
        </button>
      </div>
    </div>
  );
}
