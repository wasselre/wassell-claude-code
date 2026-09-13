/**
 * The publishing grid preview.
 *
 * Instagram's feed is three cells to a row, and the operator's placement rules
 * («لا نكرر المشروع نفسه في اليوم، ولا صفًّا يحمل مشروعًا مرتين») are RULES the
 * engine already enforced — this grid exists so a human can SEE that they hold,
 * and override one when the machine's arrangement is not the one they want.
 *
 * A cell is coloured by PROJECT, because the thing you check at a glance is
 * "are these three different projects", not "what is this post called".
 *
 * Dragging one cell onto another swaps their publishing slots and pins BOTH —
 * pinning only the dragged one would let the re-plan slide the other back
 * underneath it. The pins go to `campaign_plan_revise`, which re-runs the whole
 * engine around them; nothing is written to the database.
 */
import { useState } from 'react';
import type { PlannedItem } from '@/lib/marketingOS/scheduling';
import { PLATFORM_LABELS } from '@/lib/marketingOS/client';
import {
  buildPlanGrid, projectColor, projectColorMap, type GridCell,
} from '../lib/planPresentation';
import { num, shortDate } from '../lib/format';

export default function PlanGrid({
  items, platform, isAr, columns, busy = false, newestFirst = true, onSwap,
}: {
  items: PlannedItem[];
  platform: string;
  isAr: boolean;
  columns?: number;
  busy?: boolean;
  newestFirst?: boolean;
  onSwap?: (aKey: string, bKey: string) => void;
}) {
  const [dragKey, setDragKey] = useState<string | null>(null);
  const [overKey, setOverKey] = useState<string | null>(null);

  const colors = projectColorMap(items);
  const grid = buildPlanGrid(items, platform, { columns, newestFirst, colors });
  const label = PLATFORM_LABELS[platform];
  const platformLabel = label ? (isAr ? label.ar : label.en) : platform;

  if (grid.cells.length === 0) return null;

  const drop = (target: GridCell): void => {
    const from = dragKey;
    setDragKey(null);
    setOverKey(null);
    if (!from || !onSwap || busy || from === target.itemKey) return;
    onSwap(from, target.itemKey);
  };

  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-h">
        <h4>{isAr ? `شبكة ${platformLabel}` : `${platformLabel} grid`}</h4>
        <span className="r">
          {isAr
            ? `${num(grid.cells.length, true)} منشورًا · ${num(grid.rows.length, true)} صفوف${onSwap ? ' · اسحب خلية على أخرى لتبديلهما' : ''}`
            : `${grid.cells.length} posts · ${grid.rows.length} rows${onSwap ? ' · drag one cell onto another to swap' : ''}`}
        </span>
      </div>
      <div className="card-b">
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))`,
            gap: 8,
            maxWidth: 520,
          }}
        >
          {grid.rows.flatMap((row, ri) => row.map((cell, ci) => {
            if (!cell) {
              return (
                <div
                  key={`empty-${ri}-${ci}`}
                  style={{
                    aspectRatio: '1 / 1',
                    border: '1px dashed var(--line)',
                    borderRadius: 8,
                    background: 'var(--sand-2)',
                  }}
                />
              );
            }
            const color = projectColor(cell.colorIndex);
            const isOver = overKey === cell.itemKey && dragKey !== null && dragKey !== cell.itemKey;
            return (
              <div
                key={cell.itemKey}
                draggable={Boolean(onSwap) && !busy}
                onDragStart={() => setDragKey(cell.itemKey)}
                onDragEnd={() => { setDragKey(null); setOverKey(null); }}
                onDragOver={(e) => { if (onSwap && dragKey) { e.preventDefault(); setOverKey(cell.itemKey); } }}
                onDragLeave={() => setOverKey((k) => (k === cell.itemKey ? null : k))}
                onDrop={(e) => { e.preventDefault(); drop(cell); }}
                title={`${cell.projectName || cell.projectId} · ${cell.day}`}
                style={{
                  aspectRatio: '1 / 1',
                  border: `1px solid ${isOver ? 'var(--copper)' : 'var(--line)'}`,
                  borderInlineStartWidth: 3,
                  borderInlineStartColor: color,
                  borderRadius: 8,
                  background: `color-mix(in srgb, ${color} 12%, var(--paper))`,
                  padding: 8,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 4,
                  cursor: onSwap && !busy ? 'grab' : 'default',
                  opacity: dragKey === cell.itemKey ? 0.45 : 1,
                  overflow: 'hidden',
                }}
              >
                {/* thumb slot — <ContentThumb> goes here once the item has a design */}
                <div style={{ fontSize: 11.5, fontWeight: 700, color: 'var(--ink)', lineHeight: 1.5 }}>
                  {cell.projectName || cell.projectId}
                </div>
                <div style={{ fontSize: 10.5, color: 'var(--mute)', lineHeight: 1.6 }}>
                  {shortDate(cell.day, isAr)}
                  {' · '}
                  {isAr ? `الفترة ${num(cell.slotIndex + 1, true)}` : `slot ${cell.slotIndex + 1}`}
                </div>
                <div
                  style={{
                    marginTop: 'auto', fontSize: 10, color: 'var(--mute)',
                    direction: 'ltr', textAlign: 'start', overflowWrap: 'anywhere',
                  }}
                >
                  r{cell.row}c{cell.col}
                </div>
              </div>
            );
          }))}
        </div>
        <div style={{ fontSize: 11, color: 'var(--mute)', marginTop: 10, lineHeight: 1.8 }}>
          {isAr
            ? 'الأحدث في الأعلى، كما يظهر الحساب فعليًا. اللون للمشروع — ثلاثة ألوان مختلفة في الصف تعني أنّ قاعدة «لا تكرار في الصف» محقّقة.'
            : 'Newest row on top, the way the account actually reads. Colour is the project — three different colours in a row means the "no repeat in a row" rule holds.'}
        </div>
      </div>
    </div>
  );
}
