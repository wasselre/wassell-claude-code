import type { DashboardWidget, WidgetType } from '@/types';

const COLS = 12;

/**
 * Check if a position is occupied by any widget
 */
function isOccupied(
  grid: boolean[][],
  x: number,
  y: number,
  w: number,
  h: number,
): boolean {
  for (let row = y; row < y + h; row++) {
    for (let col = x; col < x + w; col++) {
      if (grid[row]?.[col]) return true;
    }
  }
  return false;
}

/**
 * Mark a position as occupied
 */
function occupy(grid: boolean[][], x: number, y: number, w: number, h: number): void {
  for (let row = y; row < y + h; row++) {
    if (!grid[row]) grid[row] = [];
    for (let col = x; col < x + w; col++) {
      grid[row]![col] = true;
    }
  }
}

/**
 * Find the next available position for a widget of given size
 */
function findNextPosition(
  grid: boolean[][],
  w: number,
  h: number,
): { x: number; y: number } {
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x <= COLS - w; x++) {
      if (!isOccupied(grid, x, y, w, h)) {
        return { x, y };
      }
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Get default size for a widget type
 */
export function getDefaultSize(type: WidgetType): { w: number; h: number } {
  switch (type) {
    case 'stat':
      return { w: 3, h: 3 };
    case 'bar_chart':
    case 'pie_chart':
    case 'line_chart':
      return { w: 4, h: 4 };
    case 'table':
      return { w: 5, h: 4 };
    default:
      return { w: 4, h: 3 };
  }
}

/**
 * Auto-layout all widgets so none overlap.
 * Preserves relative order but ensures no stacking.
 */
export function autoLayoutWidgets(widgets: DashboardWidget[]): DashboardWidget[] {
  const grid: boolean[][] = [];
  return widgets.map((widget) => {
    const pos = findNextPosition(grid, widget.w, widget.h);
    occupy(grid, pos.x, pos.y, widget.w, widget.h);
    return { ...widget, x: pos.x, y: pos.y };
  });
}

/**
 * Find position for a new widget given existing widgets
 */
export function findPositionForNew(
  existingWidgets: DashboardWidget[],
  w: number,
  h: number,
): { x: number; y: number } {
  const grid: boolean[][] = [];
  for (const widget of existingWidgets) {
    occupy(grid, widget.x, widget.y, widget.w, widget.h);
  }
  return findNextPosition(grid, w, h);
}
