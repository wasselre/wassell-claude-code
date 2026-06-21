/**
 * TipTap JSON → branded DOCX (Buffer) for server-side document generation.
 *
 * ⚠️ KEEP IN SYNC with buildDocxBlob + helpers in src/lib/documents/export.ts.
 * The worker is a standalone npm package and CANNOT import from src/* — same
 * COPY posture as worker/src/imageGen.ts.
 *
 * DELIBERATE DIFFERENCE from the src copy: the src `buildDocxBlob` SKIPS images
 * (they live behind short-lived signed URLs in the editor). Here images are the
 * template's LOGO and other branding, embedded inline as base64 data URIs in
 * the template content_json — so this copy EMBEDS data-URI images via
 * `ImageRun`. Non-data-URI image srcs are still skipped (can't fetch). When you
 * change the shared DOCX shape (headings/lists/tables/marks/headers), change
 * BOTH files; this one additionally owns the image-embedding logic.
 */

import {
  AlignmentType,
  BorderStyle,
  Document,
  ExternalHyperlink,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
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
  contentWidthEmu,
  type PageSettings,
} from './pageSettings.js';

/** Minimal structural TipTap node — avoids depending on @tiptap/core. */
export interface JSONContent {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: JSONContent[];
  text?: string;
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
}

interface DocxCtx {
  isAr: boolean;
  /** Usable content width in pixels @96dpi — caps embedded image width. */
  contentWidthPx: number;
}

const AR_RE = /[؀-ۿ]/;
const EMU_PER_PX = 9525; // 914400 EMU/in ÷ 96 px/in

// ─── Wassel brand palette (hex without '#', as docx wants) ──────────────────
const BRAND = {
  chocolate: '4A2C2A', // headings / strong text
  copper: 'B8734F', // secondary headings / accents
  sand: 'D4B896', // borders / dividers
  cream: 'F5EDE0', // table header / band fill
  charcoal: '4A4E54', // body text
};

function nodeText(node: JSONContent): string {
  if (node.type === 'text') return node.text ?? '';
  return (node.content ?? []).map(nodeText).join('');
}

/** Map a TipTap textAlign attr to a docx AlignmentType (undefined = default). */
function alignFromAttrs(attrs: Record<string, unknown> | undefined): (typeof AlignmentType)[keyof typeof AlignmentType] | undefined {
  switch (attrs?.textAlign) {
    case 'center':
      return AlignmentType.CENTER;
    case 'right':
      return AlignmentType.RIGHT;
    case 'left':
      return AlignmentType.LEFT;
    case 'justify':
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

export async function buildDocxBuffer(
  doc: JSONContent,
  isAr: boolean,
  settings: PageSettings = DEFAULT_PAGE_SETTINGS,
): Promise<Buffer> {
  const ctx: DocxCtx = {
    isAr,
    contentWidthPx: Math.max(120, Math.round(contentWidthEmu(settings) / EMU_PER_PX)),
  };

  const children: Array<Paragraph | Table> = [];
  for (const node of doc.content ?? []) {
    children.push(...blockToDocx(node, ctx));
  }

  // Headers / footers — real Word running parts.
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
  return Packer.toBuffer(document);
}

function blockToDocx(
  node: JSONContent,
  ctx: DocxCtx,
  listCtx?: { kind: 'bullet' | 'num'; level: number },
): Array<Paragraph | Table> {
  const bidi = AR_RE.test(nodeText(node)) || ctx.isAr;
  switch (node.type) {
    case 'paragraph': {
      const align = alignFromAttrs(node.attrs);
      return [
        new Paragraph({
          children: inlineToDocx(node.content ?? [], bidi),
          bidirectional: bidi,
          ...(align ? { alignment: align } : {}),
          ...(listCtx?.kind === 'bullet' ? { bullet: { level: listCtx.level } } : {}),
          ...(listCtx?.kind === 'num' ? { numbering: { reference: 'wassel-num', level: listCtx.level } } : {}),
        }),
      ];
    }
    case 'heading': {
      const level = Number(node.attrs?.level ?? 1);
      const heading =
        level === 1 ? HeadingLevel.HEADING_1 : level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3;
      // Brand the headings: H2 = copper accent, H1/H3 = chocolate. Direct run
      // color overrides Word's default (blue) heading style under LibreOffice.
      const color = level === 2 ? BRAND.copper : BRAND.chocolate;
      const align = alignFromAttrs(node.attrs);
      return [
        new Paragraph({
          children: inlineToDocx(node.content ?? [], bidi, color),
          heading,
          bidirectional: bidi,
          ...(align ? { alignment: align } : {}),
          spacing: { before: 200, after: 100 },
        }),
      ];
    }
    case 'bulletList':
    case 'orderedList': {
      const kind = node.type === 'bulletList' ? 'bullet' : 'num';
      const level = Math.min(listCtx ? listCtx.level + 1 : 0, 2);
      const out: Array<Paragraph | Table> = [];
      for (const li of node.content ?? []) {
        for (const child of li.content ?? []) {
          out.push(...blockToDocx(child, ctx, { kind, level }));
        }
      }
      return out;
    }
    case 'blockquote': {
      const out: Array<Paragraph | Table> = [];
      for (const child of node.content ?? []) {
        out.push(...blockToDocx(child, ctx));
      }
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
      return [tableToDocx(node, ctx)];
    case 'image':
      return imageToDocx(node, ctx);
    default: {
      const text = nodeText(node).trim();
      return text ? [new Paragraph({ children: [new TextRun(text)], bidirectional: bidi })] : [];
    }
  }
}

/** Embed a base64 data-URI image (the template's logo/branding) as an ImageRun.
 *  Non-data-URI srcs (http) are skipped — we can't fetch them reliably here. */
function imageToDocx(node: JSONContent, ctx: DocxCtx): Paragraph[] {
  const src = String(node.attrs?.src ?? '');
  const parsed = parseDataUri(src);
  if (!parsed) return [];
  const type = docxImageType(parsed.mime);
  if (!type) return []; // unsupported (e.g. webp/svg) — skip rather than crash

  const intrinsic = imageSize(parsed.bytes, parsed.mime) ?? { w: 240, h: 96 };
  // WasselImage stores width as a percent of the column (25/50/75/100).
  const pctRaw = Number(node.attrs?.width);
  const pct = Number.isFinite(pctRaw) && pctRaw > 0 && pctRaw <= 100 ? pctRaw : 100;
  let widthPx = Math.round((ctx.contentWidthPx * pct) / 100);
  // Never upscale past intrinsic — a logo shouldn't blur.
  if (widthPx > intrinsic.w) widthPx = intrinsic.w;
  if (widthPx > ctx.contentWidthPx) widthPx = ctx.contentWidthPx;
  const heightPx = Math.max(1, Math.round(widthPx * (intrinsic.h / intrinsic.w)));

  const align = String(node.attrs?.align ?? '');
  const alignment =
    align === 'center'
      ? AlignmentType.CENTER
      : align === 'end' || align === 'wrap-end'
      ? AlignmentType.END
      : AlignmentType.START;

  return [
    new Paragraph({
      alignment,
      children: [
        new ImageRun({
          data: parsed.bytes,
          type,
          transformation: { width: widthPx, height: heightPx },
        }),
      ],
    }),
  ];
}

function parseDataUri(src: string): { mime: string; bytes: Buffer } | null {
  const m = /^data:([a-z0-9.+/-]+);base64,(.+)$/i.exec(src);
  if (!m) return null;
  try {
    return { mime: m[1]!.toLowerCase(), bytes: Buffer.from(m[2]!, 'base64') };
  } catch {
    return null;
  }
}

type DocxImageType = 'jpg' | 'png' | 'gif' | 'bmp';
function docxImageType(mime: string): DocxImageType | null {
  if (mime === 'image/jpeg' || mime === 'image/jpg') return 'jpg';
  if (mime === 'image/png') return 'png';
  if (mime === 'image/gif') return 'gif';
  if (mime === 'image/bmp') return 'bmp';
  return null;
}

/** Read intrinsic pixel dimensions from PNG / JPEG / GIF / BMP headers.
 *  Returns null if it can't parse (caller falls back to a sensible default). */
function imageSize(buf: Buffer, mime: string): { w: number; h: number } | null {
  try {
    if (mime === 'image/png') {
      // IHDR width/height are big-endian uint32 at offsets 16/20.
      if (buf.length >= 24) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    } else if (mime === 'image/gif') {
      if (buf.length >= 10) return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    } else if (mime === 'image/bmp') {
      if (buf.length >= 26) return { w: buf.readInt32LE(18), h: Math.abs(buf.readInt32LE(22)) };
    } else if (mime === 'image/jpeg' || mime === 'image/jpg') {
      let off = 2; // skip SOI
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off += 1;
          continue;
        }
        const marker = buf[off + 1]!;
        // SOF0..SOF15 carry dimensions, except DHT(C4)/DAC(CC)/RSTn.
        const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        const segLen = buf.readUInt16BE(off + 2);
        if (isSof) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        off += 2 + segLen;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function tableToDocx(node: JSONContent, ctx: DocxCtx): Table {
  const rows = (node.content ?? [])
    .filter((r) => r.type === 'tableRow')
    .map(
      (row) =>
        new TableRow({
          children: (row.content ?? []).map((cell) => {
            const paras = (cell.content ?? []).flatMap((c) => blockToDocx(c, ctx));
            return new TableCell({
              children: paras.length > 0 ? (paras as Paragraph[]) : [new Paragraph('')],
              shading: cell.type === 'tableHeader' ? { fill: BRAND.cream } : undefined,
              // Comfortable padding so the info table reads like a real form.
              margins: { top: 60, bottom: 60, left: 120, right: 120 },
            });
          }),
        }),
    );
  const border = { style: BorderStyle.SINGLE, size: 4, color: BRAND.sand };
  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
    visuallyRightToLeft: ctx.isAr,
    borders: {
      top: border,
      bottom: border,
      left: border,
      right: border,
      insideHorizontal: border,
      insideVertical: border,
    },
  });
}

function inlineToDocx(nodes: JSONContent[], bidi: boolean, forceColor?: string): Array<TextRun | ExternalHyperlink> {
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
      if (text) out.push(new TextRun({ text, rightToLeft: bidi, ...(forceColor ? { color: forceColor } : {}) }));
      continue;
    }
    const marks = n.marks ?? [];
    const has = (m: string) => marks.some((x) => x.type === m);
    const sIns = has('suggestInsert');
    const sDel = has('suggestDelete');
    const run = new TextRun({
      text: n.text ?? '',
      bold: has('bold'),
      italics: has('italic'),
      strike: has('strike') || sDel,
      underline: has('underline') || sIns ? {} : undefined,
      // forceColor (e.g. branded heading color) applies unless a suggestion
      // mark needs its own signal color.
      color: sDel ? 'B91C1C' : sIns ? '8E4E3A' : forceColor ?? undefined,
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
