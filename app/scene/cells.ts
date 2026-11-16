// What each character cell of the portrait contains. Pure pixel maths, no DOM.

/** Every cell is measured from SUPER x SUPER samples. */
export const SUPER = 4;
/** Opaque pixels darker than this are line work: outlines, eyes, whiskers. */
const DARK = 0.3;

export interface Cells {
  columns: number;
  rows: number;
  /** Share of the cell the subject covers, 0-1. */
  coverage: Float32Array;
  /** Mean brightness of the covered part, 0-1, gamma-lifted. */
  tone: Float32Array;
  /** Share of the cell taken by line work, 0-1. */
  line: Float32Array;
  /** Direction of that line work in degrees, 0-180, measured with y pointing down. */
  angle: Float32Array;
  /** Vertical centre of the line work within the cell: 0 top, 1 bottom. */
  height: Float32Array;
}

const brightness = (red: number, green: number, blue: number) => (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
const isDark = (rgba: Uint8ClampedArray, offset: number) => rgba[offset + 3] > 128 && brightness(rgba[offset], rgba[offset + 1], rgba[offset + 2]) < DARK;

/** `fine` is the subject as RGBA, scaled to exactly columns*SUPER by rows*SUPER pixels. */
export function cellStats(fine: Uint8ClampedArray, columns: number, rows: number): Cells {
  const width = columns * SUPER, height = rows * SUPER, count = columns * rows;
  if (fine.length !== width * height * 4) throw new Error('Supersampled portrait has the wrong size');
  const dark = new Uint8Array(width * height);
  for (let index = 0; index < dark.length; index++) dark[index] = isDark(fine, index * 4) ? 1 : 0;
  const darkAt = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : dark[y * width + x]);
  const cells: Cells = { columns, rows, coverage: new Float32Array(count), tone: new Float32Array(count), line: new Float32Array(count), angle: new Float32Array(count), height: new Float32Array(count) };
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    let weight = 0, light = 0, lines = 0, lineY = 0, xx = 0, yy = 0, xy = 0;
    for (let sy = -1; sy <= SUPER; sy++) for (let sx = -1; sx <= SUPER; sx++) {
      const x = column * SUPER + sx, y = row * SUPER + sy;
      // Structure tensor of the line work, over the cell and a one-sample margin.
      const gx = darkAt(x + 1, y) - darkAt(x - 1, y), gy = darkAt(x, y + 1) - darkAt(x, y - 1);
      xx += gx * gx; yy += gy * gy; xy += gx * gy;
      if (sx < 0 || sy < 0 || sx >= SUPER || sy >= SUPER) continue;
      const offset = (y * width + x) * 4, alpha = fine[offset + 3] / 255;
      light += brightness(fine[offset], fine[offset + 1], fine[offset + 2]) * alpha;
      weight += alpha;
      if (dark[y * width + x]) { lines++; lineY += (sy + 0.5) / SUPER; }
    }
    const cell = row * columns + column, samples = SUPER * SUPER;
    cells.coverage[cell] = weight / samples;
    cells.tone[cell] = weight ? Math.pow(light / weight, 0.85) : 0;
    cells.line[cell] = lines / samples;
    cells.height[cell] = lines ? lineY / lines : 0.5;
    // The gradient points across a line, so the line itself runs a quarter turn from it.
    cells.angle[cell] = (0.5 * Math.atan2(2 * xy, xx - yy) * 180 / Math.PI + 90 + 360) % 180;
  }
  return cells;
}

/** The character that follows line work through a cell. */
export function strokeFor(angle: number, height: number): string {
  if (angle < 22.5 || angle >= 157.5) return height < 0.36 ? '¯' : height > 0.64 ? '_' : '-';
  if (angle < 67.5) return '\\';
  if (angle < 112.5) return '|';
  return '/';
}

/**
 * Small, roundish, isolated dark shapes: eyes, mostly. Returns their centres as 0-1
 * positions. Strokes and anything touching the outline are longer or larger and are left out.
 */
export function findSpots(rgba: Uint8ClampedArray, width: number, height: number): { x: number; y: number }[] {
  const seen = new Uint8Array(width * height);
  const spots: { x: number; y: number }[] = [];
  const area = width * height;
  const stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || !isDark(rgba, start * 4)) continue;
    let size = 0, sumX = 0, sumY = 0, left = width, right = 0, top = height, bottom = 0;
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const index = stack.pop()!, x = index % width, y = (index - x) / width;
      size++; sumX += x; sumY += y;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      for (const next of [index - width, index + width, x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1]) {
        if (next >= 0 && next < seen.length && !seen[next] && isDark(rgba, next * 4)) { seen[next] = 1; stack.push(next); }
      }
    }
    const boxWidth = right - left + 1, boxHeight = bottom - top + 1, aspect = boxWidth / boxHeight;
    if (size >= area * 0.0003 && size <= area * 0.004 && aspect > 0.5 && aspect < 2 && size >= boxWidth * boxHeight * 0.55) {
      spots.push({ x: (sumX / size + 0.5) / width, y: (sumY / size + 0.5) / height });
    }
  }
  return spots;
}
