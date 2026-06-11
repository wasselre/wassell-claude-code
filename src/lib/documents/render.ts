/**
 * Render TipTap JSON → HTML outside a live editor instance.
 *
 * Used when creating a document from a template (so content_html is correct
 * from the very first save, before the editor ever autosaves) and reusable
 * by the export feature.
 *
 * KEEP THE EXTENSION LIST IN SYNC with DocumentEditor.tsx — generateHTML
 * needs the same schema or template nodes would fail to serialize. UI-only
 * extensions (Placeholder, keyboard shortcuts) are irrelevant to the schema
 * and deliberately omitted.
 */

import { generateHTML, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import TextAlign from '@tiptap/extension-text-align';
import { Table, TableRow, TableHeader, TableCell } from '@tiptap/extension-table';
import { MentionNode } from '@/pages/Documents/components/MentionExtension';
import { PageBreak } from '@/pages/Documents/components/PageBreakExtension';

const SCHEMA_EXTENSIONS = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  Underline,
  Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noopener noreferrer' } }),
  Image.configure({ inline: false, allowBase64: false }),
  TextAlign.configure({ types: ['heading', 'paragraph'] }),
  // Mention chips (no suggestion plugin needed for serialization).
  MentionNode,
  // Tables (resizable is editor-only behavior; schema is identical).
  Table,
  TableRow,
  TableHeader,
  TableCell,
  PageBreak,
];

export function renderDocumentHtml(json: JSONContent): string {
  return generateHTML(json, SCHEMA_EXTENSIONS);
}
