export const PANEL_LIMITS = {
  left: { min: 200, max: 420 },
  right: { min: 320, max: 620 },
  collapsed: 42,
} as const;

const clamp = (value: number, minimum: number, maximum: number) =>
  Math.min(maximum, Math.max(minimum, value));

/** Keeps both sidebars usable while reserving the center editor's minimum width. */
export function resolvePanelWidths(
  width: number,
  requestedLeft: number,
  requestedRight: number,
  leftCollapsed: boolean,
  rightCollapsed: boolean,
) {
  const centerMinimum = width < 1050 ? 280 : 340;
  const left = clamp(requestedLeft, PANEL_LIMITS.left.min, PANEL_LIMITS.left.max);
  const right = clamp(requestedRight, PANEL_LIMITS.right.min, PANEL_LIMITS.right.max);
  const fixed =
    (leftCollapsed ? PANEL_LIMITS.collapsed : 0) + (rightCollapsed ? PANEL_LIMITS.collapsed : 0);
  const minimums =
    (leftCollapsed ? 0 : PANEL_LIMITS.left.min) + (rightCollapsed ? 0 : PANEL_LIMITS.right.min);
  const availableExtra = Math.max(0, width - centerMinimum - fixed - minimums);
  const leftExtra = leftCollapsed ? 0 : left - PANEL_LIMITS.left.min;
  const rightExtra = rightCollapsed ? 0 : right - PANEL_LIMITS.right.min;
  const requestedExtra = leftExtra + rightExtra;
  const ratio =
    requestedExtra > availableExtra && requestedExtra > 0 ? availableExtra / requestedExtra : 1;
  return {
    left: leftCollapsed
      ? PANEL_LIMITS.collapsed
      : Math.round(PANEL_LIMITS.left.min + leftExtra * ratio),
    right: rightCollapsed
      ? PANEL_LIMITS.collapsed
      : Math.round(PANEL_LIMITS.right.min + rightExtra * ratio),
    centerMinimum,
  };
}
