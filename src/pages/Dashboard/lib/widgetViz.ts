import type { WidgetType, WidgetViz } from '@/types';

export type VizFamily = 'stat' | 'bars' | 'pies' | 'lines' | 'table' | 'funnel' | 'leaderboard' | 'gauge' | 'progress' | 'pivot' | 'heatmap' | 'map';

// On-brand default chart palette (copper → terracotta → gold → sand → chocolate
// → charcoal) so charts look like Wassel with zero configuration.
export const BRAND_PALETTE = ['#B8734F', '#8E4E3A', '#C09B5F', '#D4B896', '#4A2C2A', '#4A4E54'];

export function vizFamilyFor(type: WidgetType): VizFamily {
  switch (type) {
    case 'stat':
      return 'stat';
    case 'bar_chart':
      return 'bars';
    case 'pie_chart':
      return 'pies';
    case 'line_chart':
      return 'lines';
    case 'table':
      return 'table';
    case 'funnel':
      return 'funnel';
    case 'leaderboard':
      return 'leaderboard';
    case 'gauge':
      return 'gauge';
    case 'progress':
      return 'progress';
    case 'pivot':
      return 'pivot';
    case 'heatmap':
      return 'heatmap';
    case 'map':
      return 'map';
    default:
      return 'stat';
  }
}

export function defaultVizForType(type: WidgetType): WidgetViz {
  switch (type) {
    case 'stat':
      return { family: 'stat', color: '#B8734F' };
    case 'bar_chart':
      return { family: 'bars', color_mode: { kind: 'by_group_option' }, show_legend: false };
    case 'pie_chart':
      return { family: 'pies', donut: false, color_mode: { kind: 'by_group_option' }, show_legend: true };
    case 'line_chart':
      return { family: 'lines', area: false, smooth: false };
    case 'table':
      return { family: 'table', page_size: 10 };
    case 'funnel':
      return { family: 'funnel', show_pct: true, color_mode: { kind: 'by_group_option' } };
    case 'leaderboard':
      return { family: 'leaderboard', max_rows: 10, color_mode: { kind: 'by_group_option' } };
    case 'gauge':
      return { family: 'gauge', color: '#B8734F' };
    case 'progress':
      return { family: 'progress', color: '#B8734F' };
    case 'pivot':
      return { family: 'pivot' };
    case 'heatmap':
      return { family: 'heatmap', color: '#B8734F' };
    case 'map':
      return { family: 'map', color: '#B8734F' };
    default:
      return { family: 'stat', color: '#B8734F' };
  }
}
