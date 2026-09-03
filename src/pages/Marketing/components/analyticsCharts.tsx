/**
 * Small SVG charts for the التحليلات page. Token-driven colors, tabular labels,
 * an emphasized endpoint, a faint baseline grid — the same care as the type.
 * Deliberately dependency-free (no chart lib) for a handful of series.
 */
import { useId } from 'react';

export interface Point { label: string; value: number }

const W = 680;
const H = 180;
const PAD = { l: 10, r: 10, t: 16, b: 26 };

function xLabels(points: Point[], x: (i: number) => number): JSX.Element[] {
  const step = Math.max(1, Math.ceil(points.length / 6));
  const out: JSX.Element[] = [];
  for (let i = 0; i < points.length; i += step) {
    out.push(
      <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fill="var(--mute)" fontSize="10">{points[i]?.label ?? ''}</text>,
    );
  }
  return out;
}

/** Line (optionally area-filled) trend. */
export function TrendChart({
  points, color = 'var(--copper)', area = true, fmt,
}: {
  points: Point[];
  color?: string;
  area?: boolean;
  fmt: (v: number) => string;
}) {
  const gid = useId().replace(/:/g, '');
  if (points.length === 0) return null;
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;
  const vals = points.map((p) => p.value);
  const max = Math.max(1, ...vals);
  const n = points.length;
  const x = (i: number): number => (n <= 1 ? PAD.l + iW / 2 : PAD.l + iW * (i / (n - 1)));
  const y = (v: number): number => PAD.t + iH * (1 - v / max);
  const pts = vals.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  const last = n - 1;
  const vLast = vals[last] ?? 0;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {area && (
          <defs>
            <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={color} stopOpacity="0.28" />
              <stop offset="1" stopColor={color} stopOpacity="0" />
            </linearGradient>
          </defs>
        )}
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={PAD.l} y1={PAD.t + iH * t} x2={W - PAD.r} y2={PAD.t + iH * t} stroke="var(--line)" strokeOpacity="0.6" />
        ))}
        {area && <path d={`M${x(0)},${y(vals[0] ?? 0)} L${pts.split(' ').join(' L')} L${x(last)},${PAD.t + iH} L${x(0)},${PAD.t + iH} Z`} fill={`url(#${gid})`} />}
        <polyline points={pts} fill="none" stroke={color} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(last)} cy={y(vLast)} r="4" fill={color} />
        <text x={x(last)} y={y(vLast) - 9} textAnchor="end" fill="var(--ink)" fontFamily="var(--serif)" fontSize="13">{fmt(vLast)}</text>
        {xLabels(points, x)}
      </svg>
    </div>
  );
}

/** Bar trend (leads/day etc.). */
export function BarChart({
  points, color = 'var(--gold)', fmt,
}: {
  points: Point[];
  color?: string;
  fmt: (v: number) => string;
}) {
  if (points.length === 0) return null;
  const iW = W - PAD.l - PAD.r;
  const iH = H - PAD.t - PAD.b;
  const vals = points.map((p) => p.value);
  const max = Math.max(1, ...vals);
  const n = points.length;
  const gap = iW / n;
  const bw = gap * 0.62;
  const last = n - 1;
  const x = (i: number): number => PAD.l + gap * i + gap / 2;
  return (
    <div className="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img">
        {[0, 0.5, 1].map((t) => (
          <line key={t} x1={PAD.l} y1={PAD.t + iH * t} x2={W - PAD.r} y2={PAD.t + iH * t} stroke="var(--line)" strokeOpacity="0.6" />
        ))}
        {vals.map((v, i) => {
          const h = Math.max(2, (iH * v) / max);
          const bx = PAD.l + gap * i + (gap - bw) / 2;
          const by = PAD.t + iH - h;
          const fill = i === last ? color : `color-mix(in srgb, ${color} 55%, transparent)`;
          return <rect key={i} x={bx} y={by} width={bw} height={h} rx="3" fill={fill} />;
        })}
        <text x={x(last)} y={PAD.t + iH - Math.max(2, (iH * (vals[last] ?? 0)) / max) - 6} textAnchor="middle" fill="var(--ink)" fontFamily="var(--serif)" fontSize="12">{fmt(vals[last] ?? 0)}</text>
        {xLabels(points, x)}
      </svg>
    </div>
  );
}

/** A compact in-card sparkline (no axis). */
export function Sparkline({ values, color }: { values: number[]; color: string }) {
  const w = 132;
  const h = 38;
  const p = 3;
  if (values.length === 0) return null;
  const max = Math.max(1, ...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const n = values.length;
  const x = (i: number): number => (n <= 1 ? w / 2 : p + (w - p * 2) * (i / (n - 1)));
  const y = (v: number): number => p + (h - p * 2) * (1 - (v - min) / span);
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" style={{ width: '100%', height: 38 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={x(n - 1)} cy={y(values[n - 1] ?? 0)} r="2.6" fill={color} />
    </svg>
  );
}
