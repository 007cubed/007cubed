// ASCII portrait: the avatar sampled to a character grid, drawn in its own colours.
export const PORTRAIT = { columns: 44, rows: 25, pitchX: 10, pitchY: 18 } as const;
const RAMP = ' .,:;irsXA253hMHGS#9B&@';

function hash(a: number, b: number, c: number): number {
  let n = (Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 1274126177)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}

/** Centre-crops the avatar and samples one colour per character cell. */
export async function samplePortrait(source: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const buffer = document.createElement('canvas');
  buffer.width = PORTRAIT.columns;
  buffer.height = PORTRAIT.rows;
  const context = buffer.getContext('2d', { willReadFrequently: true })!;
  const side = Math.min(image.naturalWidth, image.naturalHeight);
  context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, PORTRAIT.columns, PORTRAIT.rows);
  return context.getImageData(0, 0, PORTRAIT.columns, PORTRAIT.rows).data;
}

/**
 * Draws the first `reveal` share of rows. A few glyphs flash brighter on each tick; the
 * rest stay identical between frames, which keeps the animated GIF small.
 */
export function drawPortrait(canvas: HTMLCanvasElement, samples: Uint8ClampedArray, tick: number, reveal: number): void {
  const { columns, rows, pitchX, pitchY } = PORTRAIT;
  canvas.width = columns * pitchX;
  canvas.height = rows * pitchY;
  const context = canvas.getContext('2d')!;
  context.font = "700 16px 'Card Mono', monospace";
  context.textBaseline = 'middle';
  const visible = Math.ceil(reveal * rows);
  for (let row = 0; row < visible; row++) for (let column = 0; column < columns; column++) {
    const offset = (row * columns + column) * 4;
    const red = samples[offset], green = samples[offset + 1], blue = samples[offset + 2];
    const luminance = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    const glyph = RAMP[Math.min(RAMP.length - 1, Math.floor(Math.pow(luminance, 0.85) * RAMP.length))];
    if (glyph === ' ') continue;
    const flash = hash(column, row, tick) < 0.03 ? 70 : 0;
    context.fillStyle = `rgb(${[red, green, blue].map(value => Math.min(255, Math.round(value * 1.1 + flash))).join(',')})`;
    context.fillText(glyph, column * pitchX, row * pitchY + pitchY / 2);
  }
}
