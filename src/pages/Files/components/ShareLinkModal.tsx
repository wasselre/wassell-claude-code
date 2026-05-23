import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Check, Copy, Eye, Link as LinkIcon, Loader2, Lock, Trash2 } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { createShareLink, listShareLinks, revokeShareLink } from '@/lib/files/client';
import type { FileRow, SharedLink } from '@/types';
import { useAppStore } from '@/stores/appStore';

interface Props {
  file: FileRow | null;
  open: boolean;
  onClose: () => void;
}

export default function ShareLinkModal({ file, open, onClose }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  const [links, setLinks] = useState<SharedLink[]>([]);
  const [loading, setLoading] = useState(false);

  // Create-form state
  const [expiresAt, setExpiresAt] = useState<string>('');
  const [password, setPassword] = useState<string>('');
  const [allowDownload, setAllowDownload] = useState(true);
  const [creating, setCreating] = useState(false);
  const [justCreatedUrl, setJustCreatedUrl] = useState<string | null>(null);

  const reload = async () => {
    if (!file) return;
    setLoading(true);
    try {
      const rows = await listShareLinks(file.id);
      setLinks(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && file) void reload();
    if (!open) {
      setExpiresAt('');
      setPassword('');
      setAllowDownload(true);
      setJustCreatedUrl(null);
      setLinks([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, file]);

  const onCreate = async () => {
    if (!file) return;
    setCreating(true);
    try {
      const res = await createShareLink({
        fileId: file.id,
        expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
        password: password || null,
        allowDownload,
      });
      setJustCreatedUrl(res.url);
      setPassword('');
      setExpiresAt('');
      await reload();
    } finally {
      setCreating(false);
    }
  };

  const onRevoke = async (id: string) => {
    await revokeShareLink(id);
    await reload();
  };

  const copy = async (url: string) => {
    try {
      await navigator.clipboard.writeText(url);
      addToast(t('files.share.copied'), 'success');
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  };

  if (!file) return null;
  const baseOrigin = typeof window !== 'undefined' ? window.location.origin : '';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('files.share.title', { name: file.original_name })}
      maxWidth="max-w-xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-6">
        {/* Just-created link banner */}
        {justCreatedUrl && (
          <div className="rounded-xl border border-emerald-300 bg-emerald-50 p-3 flex items-center gap-2">
            <Check size={16} className="text-emerald-700 shrink-0" />
            <div className="flex-1 min-w-0 font-mono text-sm text-emerald-900 truncate">{justCreatedUrl}</div>
            <button
              onClick={() => copy(justCreatedUrl)}
              className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-emerald-700 text-white text-xs font-bold hover:bg-emerald-800"
            >
              <Copy size={12} />
              {t('files.share.copy_link')}
            </button>
          </div>
        )}

        {/* Create section */}
        <div>
          <h3 className="text-sm font-bold text-charcoal/70 uppercase tracking-wide mb-3">
            {t('files.share.create_section')}
          </h3>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-bold text-charcoal/60 mb-1">
                {t('files.share.expires_at')}
              </label>
              <input
                type="datetime-local"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full px-3 py-2 rounded-lg border border-sand/40 bg-white focus:outline-none focus:ring-2 focus:ring-copper/30"
              />
              <p className="text-xs text-charcoal/40 mt-1">{t('files.share.never_expires')}</p>
            </div>
            <div>
              <label className="block text-xs font-bold text-charcoal/60 mb-1">
                {t('files.share.password')}
              </label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={t('files.share.password_placeholder')}
                className="w-full px-3 py-2 rounded-lg border border-sand/40 bg-white focus:outline-none focus:ring-2 focus:ring-copper/30"
              />
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={allowDownload}
                onChange={(e) => setAllowDownload(e.target.checked)}
                className="w-4 h-4 accent-copper"
              />
              <span className="text-sm text-charcoal">{t('files.share.allow_download')}</span>
            </label>
            <Button onClick={onCreate} disabled={creating}>
              {creating ? <Loader2 size={14} className="animate-spin" /> : <LinkIcon size={14} />}
              {t('files.share.create')}
            </Button>
          </div>
        </div>

        {/* Existing links */}
        <div>
          <h3 className="text-sm font-bold text-charcoal/70 uppercase tracking-wide mb-3">
            {t('files.share.existing_section')}
          </h3>
          {loading ? (
            <Loader2 size={20} className="animate-spin text-copper" />
          ) : links.length === 0 ? (
            <p className="text-sm text-charcoal/40">{t('files.share.no_active_links')}</p>
          ) : (
            <ul className="space-y-2">
              {links.map((link) => {
                const url = `${baseOrigin}/share/${link.token}`;
                const expired =
                  link.expires_at !== null && new Date(link.expires_at).getTime() < Date.now();
                const inactive = !link.is_active || expired;
                return (
                  <li
                    key={link.id}
                    className={`rounded-xl border p-3 ${
                      inactive ? 'border-sand/40 bg-cream/40 opacity-60' : 'border-sand/40 bg-white'
                    }`}
                  >
                    <div className="flex items-center gap-2 mb-2">
                      <div className="flex-1 min-w-0 font-mono text-xs text-charcoal truncate">{url}</div>
                      <button
                        onClick={() => copy(url)}
                        disabled={inactive}
                        className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-charcoal/5 text-charcoal/70 text-xs font-bold hover:bg-charcoal/10 disabled:opacity-40"
                      >
                        <Copy size={12} />
                      </button>
                      {link.is_active && !expired && (
                        <button
                          onClick={() => onRevoke(link.id)}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-600 text-xs font-bold hover:bg-red-100"
                        >
                          <Trash2 size={12} />
                          {t('files.share.revoke')}
                        </button>
                      )}
                    </div>
                    <div className="flex items-center gap-3 text-xs text-charcoal/50 flex-wrap">
                      <span className="inline-flex items-center gap-1">
                        <Eye size={11} />
                        {link.view_count > 0
                          ? t('files.share.view_count', { count: link.view_count })
                          : t('files.share.no_views')}
                      </span>
                      {link.password_hash && (
                        <span className="inline-flex items-center gap-1">
                          <Lock size={11} />
                          {t('files.share.password')}
                        </span>
                      )}
                      {link.expires_at && (
                        <span>
                          {expired ? `⛔ ${t('files.share.expired')}` : new Date(link.expires_at).toLocaleString(isAr ? 'ar-SA' : undefined)}
                        </span>
                      )}
                      {!link.allow_download && (
                        <span className="text-amber-700">{t('files.share.allow_download')}: ✗</span>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>
    </Modal>
  );
}
