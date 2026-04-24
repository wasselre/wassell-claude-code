// Canvas layout constants. Kept in one place so adjusting lane width or
// vertical rhythm doesn't require hunting through multiple files.

// Lane (branch group) horizontal geometry.
export const LANE_WIDTH = 320;
export const LANE_GAP = 64;
export const LANE_PADDING_X = 16;
export const LANE_HEADER_HEIGHT = 56;

// Vertical rhythm inside a lane.
export const TRIGGER_HEIGHT = 120;
export const TRIGGER_TO_FIRST_LANE_GAP = 80;
export const NODE_HEIGHT = 88;
export const NODE_VERTICAL_GAP = 32;

// Lane's total height is derived at build time from child count, but we keep a
// minimum so empty lanes still look like containers.
export const LANE_MIN_HEIGHT = LANE_HEADER_HEIGHT + 160;

// Lane top-left origin on the canvas. Trigger sits above this row, centered.
export const LANE_ROW_Y = TRIGGER_HEIGHT + TRIGGER_TO_FIRST_LANE_GAP;
