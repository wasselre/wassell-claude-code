import type { WidgetType, WidgetViz } from '@/types';

export type VizFamily = 'stat' | 'bars' | 'pies' | 'lines' | 'table';

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
    default:
      return { family: 'stat', color: '#B8734F' };
  }
}
