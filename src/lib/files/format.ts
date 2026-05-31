/**
 * Small UI helpers for the Files System (formatting, icon resolution, etc.).
 */

import {
  FileText,
  FileImage,
  Film,
  Music,
  FileArchive,
  File,
  FileEdit,
  type LucideIcon,
} from 'lucide-react';
import type { FilePreviewKind } from '@/types';

export function formatBytes(bytes: number, isAr = false): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes === 0) return isAr ? '0 بايت' : '0 B';
  const KB = 1024;
  const MB = KB * 1024;
  const GB = MB * 1024;
  if (bytes >= GB) return `${(bytes / GB).toFixed(2)} ${isAr ? 'جيجابايت' : 'GB'}`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} ${isAr ? 'ميجابايت' : 'MB'}`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(0)} ${isAr ? 'كيلوبايت' : 'KB'}`;
  return `${bytes} ${isAr ? 'بايت' : 'B'}`;
}

export const kindIcon: Record<FilePreviewKind, LucideIcon> = {
  image: FileImage,
  pdf: FileText,
  video: Film,
  audio: Music,
  document: FileText,
  wassel_doc: FileEdit,
  archive: FileArchive,
  other: File,
};

/** Brand-aware accent color per file kind, used for card tile backgrounds. */
export const kindAccent: Record<FilePreviewKind, { bg: string; fg: string }> = {
  image:      { bg: 'bg-emerald-500/10',  fg: 'text-emerald-700' },
  pdf:        { bg: 'bg-rose-500/10',     fg: 'text-rose-700' },
  video:      { bg: 'bg-indigo-500/10',   fg: 'text-indigo-700' },
  audio:      { bg: 'bg-purple-500/10',   fg: 'text-purple-700' },
  document:   { bg: 'bg-blue-500/10',     fg: 'text-blue-700' },
  // Wassel docs use the brand copper so they read as a first-class native
  // type, not "another generic document upload".
  wassel_doc: { bg: 'bg-copper/10',       fg: 'text-copper' },
  archive:    { bg: 'bg-amber-500/10',    fg: 'text-amber-700' },
  other:      { bg: 'bg-charcoal/10',     fg: 'text-charcoal' },
};

/** Human-friendly file kind label. */
export function kindLabel(kind: FilePreviewKind, isAr: boolean): string {
  if (isAr) {
    return {
      image: 'صورة',
      pdf: 'PDF',
      video: 'فيديو',
      audio: 'صوت',
      document: 'مستند',
      wassel_doc: 'مستند وصل',
      archive: 'أرشيف',
      other: 'ملف',
    }[kind];
  }
  return {
    image: 'Image',
    pdf: 'PDF',
    video: 'Video',
    audio: 'Audio',
    document: 'Document',
    wassel_doc: 'Wassel Doc',
    archive: 'Archive',
    other: 'File',
  }[kind];
}
