/**
 * Document export — PDF / DOCX / HTML / Markdown.
 *
 * Format strategies (each picked for ACCURACY, per the PRD):
 *   - HTML:     the live editor HTML wrapped in a standalone Wassel-styled
 *               shell (Amiri webfont, RTL dir, brand palette). Opens
 *               anywhere, byte-faithful to the editor render.
 *   - Markdown: hand-rolled TipTap-JSON → GFM walk (headings, marks, lists,
 *               quotes, code, hr, links, images, GFM tables, @mentions,
 *               {{tokens}} kept literal).
 *   - PDF:      the HTML shell opened in a print window + window.print() —
 *               the browser's print engine is the ONLY client-side path with
 *               correct Arabic shaping/bidi (jsPDF mangles RTL). The user
 *               picks "Save as PDF" in the dialog.
 *   - DOCX:     real .docx via the `docx` package — headings, marks, lists,
 *               quotes, code, tables, mentions; per-paragraph bidi flags
 *               driven by Arabic-content detection; Amiri as default font.
 *               Images are SKIPPED in v1 (they live behind signed URLs).
 */

import type { JSONContent } from '@tiptap/core';
import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  LevelFormat,
  Packer,
  PageBreak,
  PageNumber,
  PageOrientation,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import {
  DEFAULT_PAGE_SETTINGS,
  docxPageGeometry,
  pageCssSize,
  MARGIN_MM,
  type PageSettings,
} from './pageSettings';

// ─── Shared helpers ───────────────────────────────────────────────────────

const AR_RE = /[؀-ۿ]/;

function nodeText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(nodeText).join('');
}

export function safeFilename(title: string): string {
  return (title || 'document').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120);
}

export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a beat to start the download before revoking.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function downloadText(filename: string, text: string, mime: string): void {
  downloadBlob(filename, new Blob([text], { type: `${mime};charset=utf-8` }));
}

// ─── HTML shell ───────────────────────────────────────────────────────────

export function buildHtmlShell(
  title: string,
  bodyHtml: string,
  dir: 'rtl' | 'ltr',
  settings: PageSettings = DEFAULT_PAGE_SETTINGS,
): string {
  const marginMm = MARGIN_MM[settings.margin];
  const hasHeader = settings.header_text.trim().length > 0;
  const hasFooter = settings.footer_text.trim().length > 0;
  return `<!DOCTYPE html>
<html lang="${dir === 'rtl' ? 'ar' : 'en'}" dir="${dir}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Amiri:ital,wght@0,400;0,700;1,400;1,700&display=swap" rel="stylesheet">
<style>
  body { font-family: 'Amiri', serif; color: #4A4E54; background: #fff; margin: 0; }
  main { max-width: 760px; margin: 0 auto; padding: 48px 32px; line-height: 1.7; font-size: 17px; }
  h1, h2, h3 { color: #4A2C2A; }
  h1 { font-size: 1.875rem; } h2 { font-size: 1.5rem; } h3 { font-size: 1.25rem; }
  p { margin: 0 0 0.6em; }
  p, h1, h2, h3, li, blockquote { unicode-bidi: plaintext; }
  blockquote { border-inline-start: 3px solid #C09B5F; margin-inline-start: 0; padding-inline-start: 14px; color: #6b6f75; }
  pre { background: #F5EDE0; border-radius: 8px; padding: 12px; overflow-x: auto; direction: ltr; }
  table { border-collapse: collapse; width: 100%; margin: 0.8em 0; }
  th, td { border: 1px solid #D4B896; padding: 6px 10px; text-align: start; vertical-align: top; }
  th { background: #F5EDE0; color: #4A2C2A; }
  img { max-width: 100%; height: auto; border-radius: 8px; }
  img[data-align='start'] { display: block; margin-inline-end: auto; }
  img[data-align='center'] { display: block; margin-inline: auto; }
  img[data-align='end'] { display: block; margin-inline-start: auto; }
  img[data-align='wrap-start'] { float: inline-start; margin: 4px 0 8px; margin-inline-end: 16px; }
  img[data-align='wrap-end'] { float: inline-end; margin: 4px 0 8px; margin-inline-start: 16px; }
  hr { border: none; border-top: 1px solid #D4B896; margin: 1.4em 0; }
  a { color: #8E4E3A; }
  [data-mention] { background: rgba(184,115,79,.12); border-radius: 6px; padding: 0 4px; color: #8E4E3A; font-weight: 700; }
  span[data-suggest='insert'] { color: #8E4E3A; background: rgba(184,115,79,.08); text-decoration: underline; text-underline-offset: 3px; }
  span[data-suggest='delete'] { color: #B91C1C; background: rgba(185,28,28,.06); text-decoration: line-through; }
  .doc-page-break { border-top: 1px dashed #C09B5F; margin: 1.4em 0; }
  .page-running { display: none; }
  @media print {
    main { padding: ${hasHeader ? '10mm' : '0'} 0 ${hasFooter ? '10mm' : '0'}; max-width: none; }
    @page { size: ${pageCssSize(settings)}; margin: ${marginMm}mm; }
    .doc-page-break { border: none; margin: 0; break-after: page; }
    /* position:fixed repeats on every printed page — the classic running
       header/footer trick (per-page numbering needs @page margin boxes,
       which Chromium doesn't support; DOCX export carries real numbers). */
    .page-running { display: block; position: fixed; inset-inline: 0; font-size: 11px; color: #8a8f96; }
    .page-running.head { top: -${Math.max(marginMm - 12, 2)}mm; }
    .page-running.foot { bottom: -${Math.max(marginMm - 12, 2)}mm; }
  }
</style>
</head>
<body>
${hasHeader ? `<div class="page-running head">${escapeHtml(settings.header_text)}</div>` : ''}
${hasFooter ? `<div class="page-running foot">${escapeHtml(settings.footer_text)}</div>` : ''}
<main>${bodyHtml}</main>
</body>
</html>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** PDF via the browser print engine — the only client-side path with correct
 *  Arabic shaping. Opens a window, waits for Amiri to load, then prints. */
export function openPrintPdf(
  title: string,
  bodyHtml: string,
  dir: 'rtl' | 'ltr',
  settings: PageSettings = DEFAULT_PAGE_SETTINGS,
): boolean {
  const w = window.open('', '_blank');
  if (!w) return false; // popup blocked — caller toasts
  const shell = buildHtmlShell(title, bodyHtml, dir, settings).replace(
    '</body>',
    `<script>document.fonts.ready.then(function(){setTimeout(function(){window.print();},150);});</script></body>`,
  );
  w.document.open();
  w.document.write(shell);
  w.document.close();
  return true;
}

// ─── Markdown ─────────────────────────────────────────────────────────────

export function tiptapToMarkdown(doc: JSONContent): string {
  const blocks = (doc.content ?? []).map((n) => blockToMd(n, 0)).filter((s) => s !== null) as string[];
  return blocks.join('\n\n').trim() + '\n';
}

function blockToMd(node: JSONContent, depth: number): string | null {
  switch (node.type) {
    case 'paragraph': {
      const text = inlineToMd(node.content ?? []);
      return text.length > 0 ? text : null;
    }
    case 'heading': {
      const level = Math.min(Math.max(Number(node.attrs?.level ?? 1), 1), 6);
      return `${'#'.repeat(level)} ${inlineToMd(node.content ?? [])}`;
    }
    case 'bulletList':
      return listToMd(node, depth, () => '- ');
    case 'orderedList': {
      let i = Number(node.attrs?.start ?? 1);
      return listToMd(node, depth, () => `${i++}. `);
    }
    case 'blockquote': {
      const inner = (node.content ?? [])
        .map((n) => blockToMd(n, depth))
        .filter((s): s is string => s !== null)
        .join('\n\n');
      return inner
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
    }
    case 'codeBlock':
      return '```\n' + nodeText(node) + '\n```';
    case 'horizontalRule':
      return '---';
    case 'pageBreak':
      return '---';
    case 'image': {
      const src = String(node.attrs?.src ?? '');
      const alt = String(node.attrs?.alt ?? '');
      return `![${alt}](${src})`;
    }
    case 'table':
      return tableToMd(node);
    default: {
      // Unknown block — degrade to its text so content is never lost.
      const text = nodeText(node).trim();
      return text.length > 0 ? text : null;
    }
  }
}

function listToMd(node: JSONContent, depth: number, marker: () => string): string {
  const indent = '  '.repeat(depth);
  return (node.content ?? [])
    .map((li) => {
      const children = li.content ?? [];
      const parts: string[] = [];
      for (const child of children) {
        if (child.type === 'bulletList' || child.type === 'orderedList') {
          parts.push(blockToMd(child, depth + 1) ?? '');
        } else {
          const md = blockToMd(child, depth) ?? '';
          parts.push(md);
        }
      }
      const [first, ...rest] = parts.filter((p) => p.length > 0);
      const head = `${indent}${marker()}${first ?? ''}`;
      return rest.length > 0 ? `${head}\n${rest.join('\n')}` : head;
    })
    .join('\n');
}

function tableToMd(node: JSONContent): string {
  const rows = (node.content ?? []).filter((r) => r.type === 'tableRow');
  if (rows.length === 0) return '';
  const cellsOf = (row: JSONContent) =>
    (row.content ?? []).map((c) => nodeText(c).replace(/\|/g, '\\|').replace(/\n+/g, ' ').trim());
  const header = cellsOf(rows[0]!);
  const lines = [`| ${header.join(' | ')} |`, `| ${header.map(() => '---').join(' | ')} |`];
  for (const row of rows.slice(1)) {
    lines.push(`| ${cellsOf(row).join(' | ')} |`);
  }
  return lines.join('\n');
}

function inlineToMd(nodes: JSONContent[]): string {
  return nodes
    .map((n) => {
      if (n.type === 'hardBreak') return '  \n';
      if (n.type === 'mention') return `@${String(n.attrs?.label ?? '')}`;
      if (n.type !== 'text') return nodeText(n);
      let text = n.text ?? '';
      const marks = n.marks ?? [];
      const has = (m: string) => marks.some((x) => x.type === m);
      if (has('code')) return `\`${text}\``;
      if (has('bold')) text = `**${text}**`;
      if (has('italic')) text = `*${text}*`;
      if (has('strike')) text = `~~${text}~~`;
      const link = marks.find((x) => x.type === 'link');
      if (link) text = `[${text}](${String(link.attrs?.href ?? '')})`;
      // Tracked changes export faithfully — <ins>/<del> are valid in GFM.
      if (has('suggestInsert')) text = `<ins>${text}</ins>`;
      if (has('suggestDelete')) text = `<del>${text}</del>`;
      return text;
    })
    .join('');
}

// ─── DOCX ─────────────────────────────────────────────────────────────────

export async function buildDocxBlob(
  doc: JSONContent,
  isAr: boolean,
  settings: PageSettings = DEFAULT_PAGE_SETTINGS,
): Promise<Blob> {
  const children: Array<Paragraph | Table> = [];
  for (const node of doc.content ?? []) {
    children.push(...blockToDocx(node, isAr));
  }

  // Headers / footers — real Word running parts. Page numbers render via
  // PageNumber.CURRENT; different-first-page maps to titlePage + empty
  // `first` header/footer parts.
  const geo = docxPageGeometry(settings);
  const headerRuns: TextRun[] = settings.header_text.trim()
    ? [new TextRun({ text: settings.header_text, rightToLeft: isAr })]
    : [];
  const footerRuns: TextRun[] = [];
  if (settings.footer_text.trim()) {
    footerRuns.push(new TextRun({ text: settings.footer_text, rightToLeft: isAr }));
  }
  if (settings.show_page_numbers) {
    if (footerRuns.length > 0) footerRuns.push(new TextRun({ text: '  —  ' }));
    footerRuns.push(new TextRun({ children: [PageNumber.CURRENT] }));
  }
  const hasHeader = headerRuns.length > 0;
  const hasFooter = footerRuns.length > 0;

  const document = new Document({
    styles: {
      default: {
        document: { run: { font: 'Amiri', size: 24 } }, // 12pt body
      },
    },
    numbering: {
      config: [
        {
          reference: 'wassel-num',
          levels: [0, 1, 2].map((level) => ({
            level,
            format: LevelFormat.DECIMAL,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
          })),
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: {
              width: geo.landscape ? geo.height : geo.width,
              height: geo.landscape ? geo.width : geo.height,
              orientation: geo.landscape ? PageOrientation.LANDSCAPE : PageOrientation.PORTRAIT,
            },
            margin: { top: geo.margin, bottom: geo.margin, left: geo.margin, right: geo.margin },
          },
          titlePage: settings.different_first_page,
        },
        headers: hasHeader
          ? {
              default: new Header({
                children: [new Paragraph({ children: headerRuns, alignment: AlignmentType.CENTER, bidirectional: isAr })],
              }),
              ...(settings.different_first_page ? { first: new Header({ children: [] }) } : {}),
            }
          : settings.different_first_page
          ? { first: new Header({ children: [] }) }
          : undefined,
        footers: hasFooter
          ? {
              default: new Footer({
                children: [new Paragraph({ children: footerRuns, alignment: AlignmentType.CENTER, bidirectional: isAr })],
              }),
              ...(settings.different_first_page ? { first: new Footer({ children: [] }) } : {}),
            }
          : settings.different_first_page
          ? { first: new Footer({ children: [] }) }
          : undefined,
        children,
      },
    ],
  });
  return Packer.toBlob(document);
}

function blockToDocx(node: JSONContent, isAr: boolean, listCtx?: { kind: 'bullet' | 'num'; level: number }): Array<Paragraph | Table> {
  const bidi = AR_RE.test(nodeText(node)) || isAr;
  switch (node.type) {
    case 'paragraph':
      return [
        new Paragraph({
          children: inlineToDocx(node.content ?? [], bidi),
          bidirectional: bidi,
          ...(listCtx?.kind === 'bullet' ? { bullet: { level: listCtx.level } } : {}),
          ...(listCtx?.kind === 'num' ? { numbering: { reference: 'wassel-num', level: listCtx.level } } : {}),
        }),
      ];
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const heading =
        level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      return [new Paragraph({ children: inlineToDocx(node.content ?? [], bidi), heading, bidirectional: bidi })];
    }
    case 'bulletList':
    case 'orderedList': {
      const kind = node.type === 'bulletList' ? 'bullet' : 'num';
      const level = Math.min(listCtx ? listCtx.level + 1 : 0, 2);
      const out: Array<Paragraph | Table> = [];
      for (const li of node.content ?? []) {
        for (const child of li.content ?? []) {
          if (child.type === 'bulletList' || child.type === 'orderedList') {
            out.push(...blockToDocx(child, isAr, { kind, level }));
          } else {
            out.push(...blockToDocx(child, isAr, { kind, level }));
          }
        }
      }
      return out;
    }
    case 'blockquote': {
      const out: Array<Paragraph | Table> = [];
      for (const child of node.content ?? []) {
        for (const p of blockToDocx(child, isAr)) {
          if (p instanceof Paragraph) {
            out.push(p);
          } else {
            out.push(p);
          }
        }
      }
      // Italicize via a wrapping paragraph isn't possible post-hoc; rebuild
      // simple: prefix quotes are acceptable fidelity for v1.
      return out;
    }
    case 'codeBlock':
      return [
        new Paragraph({
          children: [new TextRun({ text: nodeText(node), font: 'Courier New' })],
          bidirectional: false,
        }),
      ];
    case 'horizontalRule':
      return [
        new Paragraph({
          border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'D4B896' } },
        }),
      ];
    case 'pageBreak':
      return [new Paragraph({ children: [new PageBreak()] })];
    case 'table':
      return [tableToDocx(node, isAr)];
    case 'image':
      // Images live behind short-lived signed URLs — embedding requires an
      // async fetch pipeline. Skipped in v1 (documented in the PRD).
      return [];
    default: {
      const text = nodeText(node).trim();
      return text ? [new Paragraph({ children: [new TextRun(text)], bidirectional: bidi })] : [];
    }
  }
}

function tableToDocx(node: JSONContent, isAr: boolean): Table {
  const rows = (node.content ?? [])
    .filter((r) => r.type === 'tableRow')
    .map(
      (row) =>
        new TableRow({
          children: (row.content ?? []).map((cell) => {
            const paras = (cell.content ?? []).flatMap((c) => blockToDocx(c, isAr));
            return new TableCell({
              children: paras.length > 0 ? (paras as Paragraph[]) : [new Paragraph('')],
              shading: cell.type === 'tableHeader' ? { fill: 'F5EDE0' } : undefined,
            });
          }),
        }),
    );
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    visuallyRightToLeft: isAr,
  });
}

function inlineToDocx(nodes: JSONContent[], bidi: boolean): Array<TextRun | ExternalHyperlink> {
  const out: Array<TextRun | ExternalHyperlink> = [];
  for (const n of nodes) {
    if (n.type === 'hardBreak') {
      out.push(new TextRun({ text: '', break: 1 }));
      continue;
    }
    if (n.type === 'mention') {
      out.push(new TextRun({ text: `@${String(n.attrs?.label ?? '')}`, bold: true, color: '8E4E3A', rightToLeft: bidi }));
      continue;
    }
    if (n.type !== 'text') {
      const text = nodeText(n);
      if (text) out.push(new TextRun({ text, rightToLeft: bidi }));
      continue;
    }
    const marks = n.marks ?? [];
    const has = (m: string) => marks.some((x) => x.type === m);
    // Tracked changes render faithfully: proposed inserts copper+underline,
    // proposed deletes red+strikethrough (matching the editor's look).
    const sIns = has('suggestInsert');
    const sDel = has('suggestDelete');
    const run = new TextRun({
      text: n.text ?? '',
      bold: has('bold'),
      italics: has('italic'),
      strike: has('strike') || sDel,
      underline: has('underline') || sIns ? {} : undefined,
      color: sDel ? 'B91C1C' : sIns ? '8E4E3A' : undefined,
      rightToLeft: bidi,
    });
    const link = marks.find((x) => x.type === 'link');
    if (link) {
      out.push(new ExternalHyperlink({ children: [run], link: String(link.attrs?.href ?? '') }));
    } else {
      out.push(run);
    }
  }
  return out;
}
