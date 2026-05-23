import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Trash2, UserPlus } from 'lucide-react';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import type { FileRow, FilePermission, FilePermissionRole, FolderPermission, FolderRow } from '@/types';
import {
  grantFilePermission,
  grantFolderPermission,
  listFilePermissions,
  listFolderPermissions,
  revokeFilePermission,
  revokeFolderPermission,
} from '@/lib/files/client';
import { useAppStore } from '@/stores/appStore';

interface FileTarget { kind: 'file'; row: FileRow }
interface FolderTarget { kind: 'folder'; row: FolderRow }
export type PermissionTarget = FileTarget | FolderTarget;

interface Props {
  target: PermissionTarget | null;
  open: boolean;
  onClose: () => void;
}

export default function PermissionsPanel({ target, open, onClose }: Props) {
  const { t } = useTranslation();
  const isAr = useAppStore((s) => s.language === 'ar');
  const users = useAppStore((s) => s.users);
  const currentUserId = useAppStore((s) => s.currentUserId);

  const [perms, setPerms] = useState<Array<FilePermission | FolderPermission>>([]);
  const [loading, setLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState<string>('');
  const [role, setRole] = useState<FilePermissionRole>('viewer');
  const [submitting, setSubmitting] = useState(false);

  const ownerId =
    target?.kind === 'file' ? target.row.uploaded_by_user_id : target?.row.created_by_user_id;
  const displayName =
    target?.kind === 'file' ? target.row.original_name : target?.row.name ?? '';

  const reload = async () => {
    if (!target) return;
    setLoading(true);
    try {
      const rows =
        target.kind === 'file'
          ? await listFilePermissions(target.row.id)
          : await listFolderPermissions(target.row.id);
      setPerms(rows);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (open && target) void reload();
    if (!open) {
      setPerms([]);
      setSelectedUserId('');
      setRole('viewer');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, target]);

  const grantedUserIds = useMemo(() => new Set(perms.map((p) => p.user_id)), [perms]);

  const availableUsers = useMemo(
    () =>
      users.filter(
        (u) =>
          u.is_active &&
          u.id !== currentUserId &&
          u.id !== ownerId &&
          !grantedUserIds.has(u.id),
      ),
    [users, currentUserId, ownerId, grantedUserIds],
  );

  const onGrant = async () => {
    if (!target || !selectedUserId) return;
    setSubmitting(true);
    try {
      if (target.kind === 'file') {
        await grantFilePermission({ fileId: target.row.id, userId: selectedUserId, role });
      } else {
        await grantFolderPermission({ folderId: target.row.id, userId: selectedUserId, role });
      }
      setSelectedUserId('');
      setRole('viewer');
      await reload();
    } finally {
      setSubmitting(false);
    }
  };

  const onRevoke = async (userId: string) => {
    if (!target) return;
    if (target.kind === 'file') {
      await revokeFilePermission(target.row.id, userId);
    } else {
      await revokeFolderPermission(target.row.id, userId);
    }
    await reload();
  };

  if (!target) return null;
  const isFolder = target.kind === 'folder';

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t('files.permissions.title', { name: displayName })}
      maxWidth="max-w-xl"
      footer={
        <Button variant="ghost" onClick={onClose}>
          {t('common.close')}
        </Button>
      }
    >
      <div className="space-y-5">
        {isFolder && (
          <div className="text-xs px-3 py-2 rounded-lg bg-copper/5 border border-copper/20 text-charcoal/80">
            {t('files.permissions.folder_cascade_note')}
          </div>
        )}

        {/* Add new grant */}
        <div className="flex flex-col sm:flex-row gap-2 items-stretch sm:items-end">
          <div className="flex-1">
            <label className="block text-xs font-bold text-charcoal/60 mb-1">
              {t('files.permissions.select_user')}
            </label>
            <select
              value={selectedUserId}
              onChange={(e) => setSelectedUserId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-sand/40 bg-white focus:outline-none focus:ring-2 focus:ring-copper/30 text-sm"
            >
              <option value="">—</option>
              {availableUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {(isAr ? u.name_ar : u.name_en) || u.email}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs font-bold text-charcoal/60 mb-1">{t('common.type')}</label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as FilePermissionRole)}
              className="px-3 py-2 rounded-lg border border-sand/40 bg-white focus:outline-none focus:ring-2 focus:ring-copper/30 text-sm"
            >
              <option value="viewer">{t('files.permissions.role_viewer')}</option>
              <option value="editor">{t('files.permissions.role_editor')}</option>
              <option value="owner">{t('files.permissions.role_owner')}</option>
            </select>
          </div>
          <Button onClick={onGrant} disabled={!selectedUserId || submitting}>
            {submitting ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {t('files.permissions.add_user')}
          </Button>
        </div>

        {/* Existing grants */}
        <div>
          {loading ? (
            <Loader2 size={20} className="animate-spin text-copper" />
          ) : perms.length === 0 ? (
            <p className="text-sm text-charcoal/40">{t('files.permissions.no_grants')}</p>
          ) : (
            <ul className="space-y-2">
              {perms.map((perm) => {
                const grantedUser = users.find((u) => u.id === perm.user_id);
                const label = grantedUser
                  ? (isAr ? grantedUser.name_ar : grantedUser.name_en) || grantedUser.email
                  : perm.user_id.slice(0, 8);
                const roleLabel = {
                  viewer: t('files.permissions.role_viewer'),
                  editor: t('files.permissions.role_editor'),
                  owner: t('files.permissions.role_owner'),
                }[perm.role];
                return (
                  <li
                    key={perm.id}
                    className="flex items-center justify-between gap-3 px-3 py-2 rounded-xl border border-sand/40 bg-white"
                  >
                    <div className="min-w-0">
                      <div className="font-bold text-charcoal truncate">{label}</div>
                      <div className="text-xs text-charcoal/40 mt-0.5">{roleLabel}</div>
                    </div>
                    <button
                      onClick={() => onRevoke(perm.user_id)}
                      className="inline-flex items-center gap-1 px-2 py-1 rounded-lg bg-red-50 text-red-600 text-xs font-bold hover:bg-red-100"
                    >
                      <Trash2 size={12} />
                      {t('common.remove')}
                    </button>
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
