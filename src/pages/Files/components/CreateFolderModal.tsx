import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import Modal from '@/components/ui/Modal';
import Button from '@/components/ui/Button';
import { createFolder } from '@/lib/files/client';
import type { FolderRow } from '@/types';

interface Props {
  open: boolean;
  parentFolderId: string | null;
  existingNames: string[];
  onClose: () => void;
  onCreated: (folder: FolderRow) => void;
}

export default function CreateFolderModal({ open, parentFolderId, existingNames, onClose, onCreated }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setError(null);
    setSubmitting(false);
  };

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (existingNames.includes(trimmed)) {
      setError(t('files.new_folder.duplicate'));
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const folder = await createFolder(trimmed, parentFolderId);
      onCreated(folder);
      reset();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={() => {
        reset();
        onClose();
      }}
      title={t('files.new_folder.title')}
      footer={
        <>
          <Button variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('common.cancel')}
          </Button>
          <Button onClick={submit} disabled={submitting || !name.trim()}>
            {t('common.create')}
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <input
          autoFocus
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void submit();
          }}
          placeholder={t('files.new_folder.placeholder')}
          className="w-full px-4 py-2.5 rounded-xl border border-sand/40 bg-white focus:outline-none focus:ring-2 focus:ring-copper/30 focus:border-copper/40 text-charcoal"
        />
        {error && <div className="text-sm text-red-600">{error}</div>}
      </div>
    </Modal>
  );
}
