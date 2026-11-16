// The avatar as terminal art: cut out of its background and drawn in one of four styles.
import { cellStats, findSpots, strokeFor, SUPER, type Cells } from './cells.js';
import { cutOut } from './cutout.js';
import type { ColorToken, PortraitStyle } from './types.js';

type Colors = Record<ColorToken, string>;
type RGB = [number, number, number];
export interface PortraitFrame {
  /** Position of the light sweep across the portrait, 0-1, or -1 when there is none. */
  sweep: number;
  /** Animation step, for effects that flicker. */
  tick: number;
  /** How much of the portrait has appeared, 0-1. */
  reveal: number;
}
export interface Portrait {
  /** CSS size of the canvas the portrait is drawn on. */
  width: number;
  height: number;
  draw(canvas: HTMLCanvasElement, style: PortraitStyle, colors: Colors, frame: PortraitFrame): void;
}

/** The subject is drawn this wide, inside a margin that leaves room for its glow. */
const INNER = 408, PAD = 16, MAX_HEIGHT = 416;
const RAMP = ' .:-=+*#%@';
const WHITE: RGB = [255, 252, 244];

const hex = (color: string): RGB => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)) as RGB;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const mix = (from: RGB, to: RGB, amount: number): RGB => from.map((value, index) => value + (to[index] - value) * clamp(amount)) as RGB;
const css = (color: RGB, alpha = 1) => `rgba(${color.map(value => Math.round(clamp(value, 0, 255))).join(',')},${alpha})`;
const luminance = (color: RGB) => (color[0] * 0.2126 + color[1] * 0.7152 + color[2] * 0.0722) / 255;
const BAYER = [[0, 8, 2, 10], [12, 4, 14, 6], [3, 11, 1, 9], [15, 7, 13, 5]].map(row => row.map(value => (value + 0.5) / 16));

function hash(a: number, b: number, c: number): number {
  let n = (Math.imul(a + 1, 374761393) ^ Math.imul(b + 1, 668265263) ^ Math.imul(c + 1, 1274126177)) >>> 0;
  n = Math.imul(n ^ (n >>> 13), 1274126177) >>> 0;
  return ((n ^ (n >>> 16)) >>> 0) / 4294967296;
}
function makeCanvas(width: number, height: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  return [canvas, canvas.getContext('2d', { willReadFrequently: true })!];
}
/** A soft light from the top left, -0.5..0.5, so flat cartoon surfaces get some shading. */
const light = (u: number, v: number) => 0.5 - (u * 0.55 + v) / 1.55;
/** Strength of the diagonal light sweep at a point, 0-1. */
function shine(u: number, v: number, sweep: number): number {
  if (sweep < 0) return 0;
  const distance = Math.abs((u + 0.5 * v) / 1.5 - (sweep * 1.4 - 0.2));
  return distance < 0.1 ? 1 - distance / 0.1 : 0;
}
/** Adds a blurred copy of the drawing on top of itself: the glow of lit characters. */
function bloom(canvas: HTMLCanvasElement, radius: number, alpha: number): void {
  const [copy, copyContext] = makeCanvas(canvas.width, canvas.height);
  copyContext.drawImage(canvas, 0, 0);
  const context = canvas.getContext('2d')!;
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.globalAlpha = alpha;
  context.filter = `blur(${radius}px)`;
  context.drawImage(copy, 0, 0);
  context.restore();
}
/** Film grain. The speckle is the same on every frame, so it adds nothing to the animation's size. */
function grain(canvas: HTMLCanvasElement, amount: number): void {
  const context = canvas.getContext('2d')!;
  const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = pixels.data;
  for (let index = 0; index < data.length; index += 4) {
    if (!data[index + 3]) continue;
    const gain = 1 - amount + 2 * amount * hash(index >> 2, 3, 5);
    data[index] *= gain; data[index + 1] *= gain; data[index + 2] *= gain;
  }
  context.putImageData(pixels, 0, 0);
}

export async function loadPortrait(source: string): Promise<Portrait> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const [full, fullContext] = makeCanvas(image.naturalWidth, image.naturalHeight);
  fullContext.drawImage(image, 0, 0);
  const pixels = fullContext.getImageData(0, 0, full.width, full.height);
  const { box } = cutOut(pixels.data, full.width, full.height);
  fullContext.putImageData(pixels, 0, 0);
  const [subject, subjectContext] = makeCanvas(box.width, box.height);
  subjectContext.drawImage(full, box.left, box.top, box.width, box.height, 0, 0, box.width, box.height);
  const spots = findSpots(subjectContext.getImageData(0, 0, box.width, box.height).data, box.width, box.height);
  const innerHeight = Math.min(MAX_HEIGHT, Math.round(INNER * box.height / box.width / 16) * 16);
  const width = INNER + PAD * 2, height = innerHeight + PAD * 2;

  const cache = new Map<string, { cells: Cells; spots: Set<number> }>();
  /** The subject divided into a grid of character cells, with the cells that hold an eye. */
  function grid(columns: number, rows: number) {
    const key = `${columns}x${rows}`;
    let entry = cache.get(key);
    if (!entry) {
      // Step down in halves so every source pixel contributes to its sample.
      let scaled = subject;
      while (scaled.width > columns * SUPER * 2) {
        const [half, halfContext] = makeCanvas(Math.ceil(scaled.width / 2), Math.ceil(scaled.height / 2));
        halfContext.imageSmoothingQuality = 'high';
        halfContext.drawImage(scaled, 0, 0, half.width, half.height);
        scaled = half;
      }
      const [, fineContext] = makeCanvas(columns * SUPER, rows * SUPER);
      fineContext.imageSmoothingQuality = 'high';
      fineContext.drawImage(scaled, 0, 0, columns * SUPER, rows * SUPER);
      const cells = cellStats(fineContext.getImageData(0, 0, columns * SUPER, rows * SUPER).data, columns, rows);
      cache.set(key, entry = { cells, spots: new Set(spots.map(spot => Math.floor(spot.y * rows) * columns + Math.floor(spot.x * columns))) });
    }
    return entry;
  }

  /** Characters at terminal size in one colour, outlines as strokes: the classic ASCII look. */
  function mono(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame, matrix: boolean): void {
    const context = canvas.getContext('2d')!;
    const cellWidth = 8, cellHeight = 16, columns = INNER / cellWidth, rows = innerHeight / cellHeight;
    const { cells, spots: eyes } = grid(columns, rows);
    const background = hex(colors.bg), ink = hex(matrix ? colors.green : colors.accent), bright = hex(colors.fgBright);
    context.font = "700 14px 'Card Mono', monospace";
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    const put = (glyph: string, column: number, row: number, color: RGB) => {
      context.fillStyle = css(color);
      context.fillText(glyph, column * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2 + 1);
    };
    // A faint field behind the subject, like an idle screen: dots, or stray bits for the matrix.
    for (let row = 0; row < height / cellHeight; row++) for (let column = 0; column < width / cellWidth; column++) {
      if (matrix ? hash(column, row, 3) < 0.55 : true) put(matrix ? (hash(column, row, 4) < 0.5 ? '0' : '1') : '·', column, row, mix(background, ink, matrix ? 0.07 : 0.16));
    }
    const step = Math.floor(frame.reveal * 8);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const cell = row * columns + column, coverage = cells.coverage[cell], lineWork = cells.line[cell] > 0.14;
      if (coverage < 0.2 || (coverage < 0.55 && !lineWork)) continue;
      const u = column / columns, v = row / rows, order = hash(column, row, 7);
      // Mono resolves out of noise in random order; the matrix rains in from the top.
      if (matrix ? v > frame.reveal * 1.25 - order * 0.25 : frame.reveal < 1 && order > frame.reveal * 1.3) continue;
      const x = PAD + column * cellWidth, y = PAD + row * cellHeight;
      context.clearRect(x, y, cellWidth, cellHeight);
      const glow = shine(u, v, frame.sweep), tone = clamp(cells.tone[cell] + light(u, v) * 0.12);
      const at = [column + PAD / cellWidth, row + PAD / cellHeight] as const;
      if (matrix) {
        // Every cell is a bit; brightness alone carries the picture. Outlines stay dark.
        const level = lineWork && cells.line[cell] > 0.3 ? 0.03 : clamp(0.34 + Math.pow(tone, 1.4) * 0.78 + glow * 0.4);
        context.fillStyle = css(mix(background, ink, 0.05 + level * 0.14));
        context.fillRect(x, y, cellWidth, cellHeight);
        const flipped = hash(column, row, frame.tick) < 0.01 ? frame.tick : 0;
        const color = level < 0.72 ? mix(mix(background, ink, 0.2), ink, level / 0.72) : mix(ink, [236, 255, 232], (level - 0.72) / 0.28 * 0.85);
        put(hash(column, row, 11 + flipped) < 0.5 ? '0' : '1', ...at, color);
      } else if (frame.reveal < 1 && order > frame.reveal * 1.3 - 0.3) {
        put(RAMP[1 + Math.floor(hash(column, row, step + 20) * (RAMP.length - 1))], ...at, mix(background, ink, 0.5));
      } else if (eyes.has(cell) || lineWork) {
        put(eyes.has(cell) ? 'o' : strokeFor(cells.angle[cell], cells.height[cell]), ...at, mix(bright, [255, 255, 255], glow * 0.5));
      } else {
        const glyph = RAMP[Math.min(RAMP.length - 1, 1 + Math.floor(clamp(tone * 1.08 + glow * 0.15) * (RAMP.length - 1)))];
        put(glyph, ...at, mix(mix(background, ink, 0.62 + tone * 0.38), bright, glow * 0.6));
      }
    }
    if (matrix) {
      // Scanlines, then phosphor bloom.
      context.fillStyle = css(background, 0.34);
      for (let y = 2; y < height; y += 4) context.fillRect(0, y, width, 2);
      bloom(canvas, 6, 0.6);
    } else {
      grain(canvas, 0.14);
      bloom(canvas, 5, 0.28);
    }
  }

  /** Small characters coloured by surface, the way a fastfetch logo uses the terminal palette. */
  function color(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const cellWidth = 6, cellHeight = 12, columns = INNER / cellWidth, rows = Math.floor(innerHeight / cellHeight);
    const { cells, spots: eyes } = grid(columns, rows);
    const top = PAD + (innerHeight - rows * cellHeight) / 2;
    const background = hex(colors.bg), bright = hex(colors.fgBright), body = hex(colors.yellow), shade = hex(colors.blue), outline = hex(colors.magenta);
    context.font = "700 11px 'Card Mono', monospace";
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    for (let row = 0; row < Math.ceil(frame.reveal * rows); row++) for (let column = 0; column < columns; column++) {
      const cell = row * columns + column, coverage = cells.coverage[cell], lineWork = cells.line[cell] > 0.2 || eyes.has(cell);
      if (coverage < 0.25 || (coverage < 0.55 && !lineWork)) continue;
      const u = column / columns, v = row / rows, glow = shine(u, v, frame.sweep), tone = cells.tone[cell];
      const surface = lineWork ? outline : tone > 0.9 ? bright : tone > 0.58 ? body : shade;
      const depth = clamp(0.62 + light(u, v) * 0.55 + (tone > 0.58 ? 0.12 : -0.12));
      const x = PAD + column * cellWidth, y = top + row * cellHeight;
      // A dim tint behind each character joins the rows into one surface.
      context.fillStyle = css(mix(background, surface, lineWork ? 0.2 : 0.14 + depth * 0.14));
      context.fillRect(x, y, cellWidth, cellHeight);
      context.fillStyle = css(mix(lineWork ? mix(background, surface, 0.92) : mix(mix(background, surface, 0.72), surface, depth), WHITE, glow * 0.55));
      const glyph = eyes.has(cell) ? 'o' : lineWork ? strokeFor(cells.angle[cell], cells.height[cell]) : RAMP[Math.min(RAMP.length - 1, 2 + Math.floor(clamp(depth + glow * 0.2) * (RAMP.length - 2)))];
      context.fillText(glyph, x + cellWidth / 2, y + cellHeight / 2 + 0.5);
    }
    bloom(canvas, 4, 0.3);
  }

  /** ANSI art: shade blocks dithered between neighbouring colours of a ramp built from the theme. */
  function blocks(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const size = 8, columns = INNER / size, rows = innerHeight / size;
    const { cells } = grid(columns, rows);
    const background = hex(colors.bg), bright = hex(colors.fgBright);
    const mids = [hex(colors.blue), hex(colors.magenta)].sort((a, b) => luminance(a) - luminance(b));
    const tones = [mix(background, mids[0], 0.42), mids[0], mix(mids[1], bright, 0.3), mix(bright, WHITE, 0.3)];
    // Thin line work (whiskers) counts as filled; a block with no neighbour at all is a stray.
    const filled = (column: number, row: number) => column >= 0 && row >= 0 && column < columns && row < rows
      && (cells.coverage[row * columns + column] >= 0.5 || cells.line[row * columns + column] >= 0.2);
    for (let row = 0; row < Math.ceil(frame.reveal * rows); row++) for (let column = 0; column < columns; column++) {
      if (!filled(column, row) || !(filled(column - 1, row) || filled(column + 1, row) || filled(column, row - 1) || filled(column, row + 1))) continue;
      const cell = row * columns + column, u = column / columns, v = row / rows;
      const outline = cells.line[cell] > 0.3 || cells.coverage[cell] < 0.5;
      const tone = outline ? 0 : clamp(cells.tone[cell] * 1.02 + light(u, v) * 0.3 + shine(u, v, frame.sweep) * 0.3);
      const scaled = tone * (tones.length - 1), lower = Math.min(tones.length - 2, Math.floor(scaled));
      // Five shades per colour pair, as with the space, light, medium, dark and full block characters.
      const shade = Math.round((scaled - lower) * 4) / 4;
      for (let py = 0; py < size; py += 2) for (let px = 0; px < size; px += 2) {
        context.fillStyle = css(tones[shade > BAYER[(py >> 1) & 3][(px >> 1) & 3] ? lower + 1 : lower]);
        context.fillRect(PAD + column * size + px, PAD + row * size + py, 2, 2);
      }
    }
    bloom(canvas, 6, 0.18);
  }

  return {
    width, height,
    draw(canvas, style, colors, frame) {
      canvas.width = width;
      canvas.height = height;
      if (style === 'color') color(canvas, colors, frame);
      else if (style === 'blocks') blocks(canvas, colors, frame);
      else mono(canvas, colors, frame, style === 'matrix');
    },
  };
}
