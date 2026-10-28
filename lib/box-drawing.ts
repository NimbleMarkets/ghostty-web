/** Cell-filling box glyphs, shared by Canvas2D and the GPU glyph atlas.
 * Font ink follows the font's advance/line box, not our rounded, emoji-safe
 * cell metrics. Never scale ordinary text to compensate for that difference.
 */
const LEFT = 1;
const RIGHT = 2;
const UP = 4;
const DOWN = 8;
const masks = [
  LEFT | RIGHT,
  UP | DOWN,
  RIGHT | DOWN,
  LEFT | DOWN,
  RIGHT | UP,
  LEFT | UP,
  UP | DOWN | RIGHT,
  UP | DOWN | LEFT,
  LEFT | RIGHT | DOWN,
  LEFT | RIGHT | UP,
  LEFT | RIGHT | UP | DOWN,
];
const boxes = new Map<number, { mask: number; weight: number; rounded?: boolean }>();
for (const [weight, chars] of [
  [1, '─│┌┐└┘├┤┬┴┼'],
  [2, '━┃┏┓┗┛┣┫┳┻╋'],
  [3, '═║╔╗╚╝╠╣╦╩╬'],
] as const) {
  [...chars].forEach((char, i) => boxes.set(char.codePointAt(0)!, { mask: masks[i], weight }));
}
[...'╭╮╰╯'].forEach((char, i) =>
  boxes.set(char.codePointAt(0)!, {
    mask: masks[i + 2],
    weight: 1,
    rounded: true,
  })
);

/** Draw in the current fillStyle/globalAlpha. Unsupported glyphs and clusters
 * must use the normal font path. Geometry ignores bold/italic (as block
 * elements do); Unicode light/heavy/double selects the actual stroke weight.
 */
export function drawBoxDrawing(
  ctx: CanvasRenderingContext2D,
  grapheme: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fontSize: number
): boolean {
  if (grapheme.length !== 1) return false;
  const box = boxes.get(grapheme.charCodeAt(0));
  if (!box) return false;
  const thin = Math.max(1, Math.round(fontSize / 14));
  const stroke = box.weight === 2 ? thin * 2 : thin;
  // Integral stroke bounds keep straight lines crisp in the CSS-pixel atlas.
  // Each family uses the same center for straight segments and junctions.
  const cx = Math.floor((width - stroke) / 2) + stroke / 2;
  const cy = Math.floor((height - stroke) / 2) + stroke / 2;
  const left = !!(box.mask & LEFT),
    right = !!(box.mask & RIGHT);
  const up = !!(box.mask & UP),
    down = !!(box.mask & DOWN);
  if (box.rounded) {
    const radius = Math.min(cx, width - cx, cy, height - cy);
    const sx = right ? 1 : -1,
      sy = down ? 1 : -1;
    ctx.save();
    ctx.strokeStyle = ctx.fillStyle;
    ctx.lineWidth = thin;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(x + (right ? width : 0), y + cy);
    ctx.lineTo(x + cx + sx * radius, y + cy);
    ctx.quadraticCurveTo(x + cx, y + cy, x + cx, y + cy + sy * radius);
    ctx.lineTo(x + cx, y + (down ? height : 0));
    ctx.stroke();
    ctx.restore();
    return true;
  }
  // Fill a single path so overlapping arms do not double-apply faint alpha.
  ctx.beginPath();
  const rect = (a: number, b: number, w: number, h: number) => ctx.rect(x + a, y + b, w, h);
  if (box.weight !== 3) {
    if (left) rect(0, cy - stroke / 2, cx + stroke / 2, stroke);
    if (right) rect(cx - stroke / 2, cy - stroke / 2, width - cx + stroke / 2, stroke);
    if (up) rect(cx - stroke / 2, 0, stroke, cy + stroke / 2);
    if (down) rect(cx - stroke / 2, cy - stroke / 2, stroke, height - cy + stroke / 2);
  } else {
    // Two rails separated by one stroke. At corners/tees each rail stops
    // at its matching perpendicular rail, preserving the hollow junction.
    const offset = thin;
    for (const sign of [-1, 1]) {
      const yy = cy + sign * offset;
      const xx = cx + sign * offset;
      const adjacentY = sign < 0 ? up : down;
      const adjacentX = sign < 0 ? left : right;
      if (left) {
        const end = right && !adjacentY ? cx : cx + (adjacentY ? -offset : offset) + thin / 2;
        rect(0, yy - thin / 2, end, thin);
      }
      if (right) {
        const start = left && !adjacentY ? cx : cx + (adjacentY ? offset : -offset) - thin / 2;
        rect(start, yy - thin / 2, width - start, thin);
      }
      if (up) {
        const end = down && !adjacentX ? cy : cy + (adjacentX ? -offset : offset) + thin / 2;
        rect(xx - thin / 2, 0, thin, end);
      }
      if (down) {
        const start = up && !adjacentX ? cy : cy + (adjacentX ? offset : -offset) - thin / 2;
        rect(xx - thin / 2, start, thin, height - start);
      }
    }
  }
  ctx.fill();
  return true;
}
