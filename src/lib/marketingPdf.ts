import html2canvas from 'html2canvas';
import jsPDF from 'jspdf';
import React from 'react';
import { createRoot } from 'react-dom/client';
import type { Reel, Post } from '@/types';
import {
  ReelsPdfTemplate,
  PostsPdfTemplate,
} from '@/pages/Marketing/components/MarketingPdfTemplates';

async function renderAndSave(
  node: React.ReactElement,
  ref: React.RefObject<HTMLDivElement | null>,
  filename: string,
): Promise<void> {
  const container = document.createElement('div');
  container.style.position = 'absolute';
  container.style.left = '-9999px';
  container.style.top = '0';
  document.body.appendChild(container);

  const root = createRoot(container);
  try {
    await new Promise<void>((resolve) => {
      root.render(node);
      setTimeout(resolve, 500);
    });

    const element = ref.current ?? (container.firstElementChild as HTMLElement | null);
    if (!element) return;

    const canvas = await html2canvas(element, {
      scale: 2,
      useCORS: true,
      backgroundColor: '#F5EDE0',
    });

    const pdf = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const pdfWidth = 210;
    const pdfHeight = 297;
    const imgWidth = pdfWidth;
    const imgHeight = (canvas.height * pdfWidth) / canvas.width;
    const imgData = canvas.toDataURL('image/png');

    if (imgHeight <= pdfHeight) {
      pdf.addImage(imgData, 'PNG', 0, 0, imgWidth, imgHeight);
    } else {
      // Multi-page: slice the canvas vertically.
      let remaining = imgHeight;
      let offsetY = 0;
      while (remaining > 0) {
        pdf.addImage(imgData, 'PNG', 0, -offsetY, imgWidth, imgHeight);
        remaining -= pdfHeight;
        offsetY += pdfHeight;
        if (remaining > 0) pdf.addPage();
      }
    }
    pdf.save(filename);
  } finally {
    root.unmount();
    document.body.removeChild(container);
  }
}

function safeFilename(projectName: string, kind: string, count: number): string {
  const safe = projectName.replace(/[\\/:*?"<>|]/g, '-').trim() || 'project';
  return `${safe}-${kind}-${count}.pdf`;
}

export async function exportReelsPdf(projectName: string, reels: Reel[]): Promise<void> {
  if (reels.length === 0) return;
  const ref = React.createRef<HTMLDivElement>();
  const sorted = [...reels].sort((a, b) => a.reel_number - b.reel_number);
  await renderAndSave(
    React.createElement(ReelsPdfTemplate, { projectName, reels: sorted, ref }),
    ref,
    safeFilename(projectName, 'reels', sorted.length),
  );
}

export async function exportPostsPdf(projectName: string, posts: Post[]): Promise<void> {
  if (posts.length === 0) return;
  const ref = React.createRef<HTMLDivElement>();
  const sorted = [...posts].sort((a, b) => a.post_number - b.post_number);
  await renderAndSave(
    React.createElement(PostsPdfTemplate, { projectName, posts: sorted, ref }),
    ref,
    safeFilename(projectName, 'posts', sorted.length),
  );
}
