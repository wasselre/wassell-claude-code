import { useNavigate } from 'react-router-dom';
import { ArrowLeft } from 'lucide-react';
import { useAppStore } from '@/stores/appStore';

/**
 * Back link to the Settings home page (the cards grid). Rendered at the top
 * of every Settings sub-page so users can return without relying on the
 * sidebar or the browser back button. Kept as a shared component so the
 * affordance is identical across all settings pages.
 */
export default function BackToSettings({ className = '' }: { className?: string }) {
  const navigate = useNavigate();
  const isAr = useAppStore((s) => s.language === 'ar');
  return (
    <button
      onClick={() => navigate('/settings')}
      className={`inline-flex items-center gap-1.5 text-xs text-charcoal/50 hover:text-copper transition mb-4 ${className}`}
    >
      <ArrowLeft size={14} className="rtl:rotate-180" />
      <span>{isAr ? 'الإعدادات' : 'Settings'}</span>
    </button>
  );
}
