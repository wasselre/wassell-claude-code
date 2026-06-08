import { useAppStore } from '@/stores/appStore';
import DriveBrowserModal, { type DrivePickerResult } from '@/pages/Files/components/DriveBrowserModal';
import { promoteChatImage } from '@/lib/assets/promote';
import type { MessageImage } from '@/lib/imageChat/client';

interface Props {
  image: MessageImage;
  /** Index of this image within its message's images[] (for the dedup cache). */
  imageIndex: number;
  messageId: string;
  /** The image_chats conversation record id (for the dedup cache). */
  chatRecordId: string;
  onClose: () => void;
}

/**
 * "Add to Files" — pick a Drive folder, then copy the generated chat image
 * into the Files System as a `files` row in that folder. The chat's original
 * marketing-assets object is never touched (copy, don't move). Reuses the
 * shared DriveBrowserModal folder picker (inline New Folder built in).
 */
export default function AddImageToFilesModal({
  image,
  imageIndex,
  messageId,
  chatRecordId,
  onClose,
}: Props) {
  const isAr = useAppStore((s) => s.language === 'ar');
  const addToast = useAppStore((s) => s.addToast);

  async function handleSelect(result: DrivePickerResult) {
    if (result.kind !== 'folder') return;
    try {
      await promoteChatImage({
        sourceUrl: image.url,
        folderId: result.folderId,
        chatRecordId,
        messageId,
        imageIndex,
      });
      addToast(isAr ? 'تم الحفظ في الملفات' : 'Saved to Files', 'success');
      onClose();
    } catch (err) {
      addToast(err instanceof Error ? err.message : String(err), 'error');
    }
  }

  return (
    <DriveBrowserModal
      open
      mode="pick-folder"
      onClose={onClose}
      onSelect={(r) => void handleSelect(r)}
    />
  );
}
