// The avatar as terminal art: cut out of its background and drawn in one of four styles.
import { cellStats, findSpots, strokeFor, SUPER, type Cells } from './cells.js';
import { cutOut } from './cutout.js';
import type { ColorToken, PortraitStyle } from './types.js';

type Colors = Record<ColorToken, string>;
type RGB = [number, number, number];
export interface PortraitFrame {
  /** Idle animation step. 0 is the portrait at rest; every hold frame after that disturbs it a little. */
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
/** What a stroke briefly turns into while the mono portrait is unsettled. */
const GLITCH = '/\\|-_+*=<>';
/** Cipher text: what a character of the colour portrait looks like before it is decrypted. */
const CIPHER = '01#$%&@?<>{}[]';
/** Brightness of a rain drop from its head back along its tail. */
const RAIN = [1, 0.55, 0.32, 0.18];
/** Width, in blocks, of the raw escape code the blocks portrait prints when it glitches. */
const ESCAPE_CELLS = 13;
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

  // Every style draws the portrait at rest, lets it glow, and only then adds its idle effect
  // as small crisp touches. Glowing the effect too would smear every change across the
  // picture and make each animation frame many times heavier.
  const idle = (frame: PortraitFrame) => frame.tick > 0 && frame.reveal === 1;

  /** Characters at terminal size in one colour, outlines as strokes: the classic ASCII look. */
  function mono(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame, matrix: boolean): void {
    const context = canvas.getContext('2d')!;
    const cellWidth = 8, cellHeight = 16, columns = INNER / cellWidth, rows = innerHeight / cellHeight;
    const fieldColumns = width / cellWidth, fieldRows = height / cellHeight, offsetX = PAD / cellWidth, offsetY = PAD / cellHeight;
    const { cells, spots: eyes } = grid(columns, rows);
    const background = hex(colors.bg), ink = hex(matrix ? colors.green : colors.accent), bright = hex(colors.fgBright);
    context.font = "700 14px 'Card Mono', monospace";
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    const put = (glyph: string, column: number, row: number, color: RGB) => {
      context.fillStyle = css(color);
      context.fillText(glyph, column * cellWidth + cellWidth / 2, row * cellHeight + cellHeight / 2 + 1);
    };
    const scanlines = (x: number, y: number, w: number, h: number) => {
      context.fillStyle = css(background, 0.34);
      for (let line = y + 2; line < y + h; line += 4) context.fillRect(x, line, w, 2);
    };
    const lineWork = (cell: number) => cells.line[cell] > 0.14;
    const shown = (column: number, row: number) => column >= 0 && row >= 0 && column < columns && row < rows
      && cells.coverage[row * columns + column] >= (lineWork(row * columns + column) ? 0.2 : 0.55);
    /** Draws one cell of the subject. A `variant` above 0 gives its scrambled look for that step. */
    const draw = (column: number, row: number, variant: number) => {
      const cell = row * columns + column, x = PAD + column * cellWidth, y = PAD + row * cellHeight;
      const tone = clamp(cells.tone[cell] + light(column / columns, row / rows) * 0.12), at = [column + offsetX, row + offsetY] as const;
      context.clearRect(x, y, cellWidth, cellHeight);
      if (matrix) {
        // Every cell is a bit; brightness alone carries the picture. Outlines stay dark.
        // A flipping bit (a variant) lights up for its step.
        const level = variant ? 1 : cells.line[cell] > 0.3 ? 0.03 : clamp(0.34 + Math.pow(tone, 1.4) * 0.78);
        context.fillStyle = css(mix(background, ink, variant ? 0.32 : 0.05 + level * 0.14));
        context.fillRect(x, y, cellWidth, cellHeight);
        put(hash(column, row, 11 + variant) < 0.5 ? '0' : '1', ...at, level < 0.72 ? mix(mix(background, ink, 0.2), ink, level / 0.72) : mix(ink, [236, 255, 232], (level - 0.72) / 0.28 * 0.85));
      } else if (eyes.has(cell)) {
        put('o', ...at, bright);
      } else if (lineWork(cell)) {
        put(variant ? GLITCH[Math.floor(hash(column, row, 200 + variant) * GLITCH.length)] : strokeFor(cells.angle[cell], cells.height[cell]), ...at, bright);
      } else {
        const level = 1 + Math.floor(clamp(tone * 1.08) * (RAMP.length - 1)) + (variant ? (hash(column, row, 300 + variant) < 0.5 ? 2 : -2) : 0);
        put(RAMP[Math.max(1, Math.min(RAMP.length - 1, level))], ...at, mix(background, ink, 0.62 + tone * 0.38));
      }
    };
    // A faint field behind the subject, like an idle screen: dots, or stray bits for the matrix.
    const field = (column: number, row: number) => {
      if (!matrix) put('·', column, row, mix(background, ink, 0.16));
      else if (hash(column, row, 3) < 0.55) put(hash(column, row, 4) < 0.5 ? '0' : '1', column, row, mix(background, ink, 0.07));
    };
    for (let row = 0; row < fieldRows; row++) for (let column = 0; column < fieldColumns; column++) field(column, row);
    const step = Math.floor(frame.reveal * 8);
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      if (!shown(column, row)) continue;
      const order = hash(column, row, 7);
      // Mono resolves out of noise in random order; the matrix rains in from the top.
      if (matrix ? row / rows > frame.reveal * 1.25 - order * 0.25 : frame.reveal < 1 && order > frame.reveal * 1.3) continue;
      if (!matrix && frame.reveal < 1 && order > frame.reveal * 1.3 - 0.3) {
        context.clearRect(PAD + column * cellWidth, PAD + row * cellHeight, cellWidth, cellHeight);
        put(RAMP[1 + Math.floor(hash(column, row, step + 20) * (RAMP.length - 1))], column + offsetX, row + offsetY, mix(background, ink, 0.5));
      } else draw(column, row, 0);
    }
    if (matrix) {
      scanlines(0, 0, width, height);
      bloom(canvas, 6, 0.6);
    } else {
      grain(canvas, 0.14);
      bloom(canvas, 5, 0.28);
    }
    if (!idle(frame)) return;
    if (!matrix) {
      // Idle effect: the output is not quite settled. On every step a few strokes on the
      // outline scramble, and a few characters of the fill step along the ramp.
      for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
        if (shown(column, row) && hash(column, row, 100 + frame.tick) < (lineWork(row * columns + column) ? 0.06 : 0.02)) draw(column, row, frame.tick);
      }
      return;
    }
    // Idle effect: digital rain. A third of the columns carry a drop that falls one cell per
    // step, a bright head with a short fading tail, passing behind the subject...
    for (let column = 0; column < fieldColumns; column++) {
      if (hash(column, 0, 9) >= 0.32) continue;
      const period = fieldRows + 6 + Math.floor(hash(column, 1, 9) * 12), head = (frame.tick + Math.floor(hash(column, 2, 9) * period)) % period;
      for (let tail = 0; tail < RAIN.length; tail++) {
        const row = head - tail;
        if (row < 0 || row >= fieldRows || shown(column - offsetX, row - offsetY)) continue;
        context.clearRect(column * cellWidth, row * cellHeight, cellWidth, cellHeight);
        put(hash(column, row, 4) < 0.5 ? '0' : '1', column, row, tail ? mix(background, ink, RAIN[tail]) : mix(ink, [236, 255, 232], 0.7));
        scanlines(column * cellWidth, row * cellHeight, cellWidth, cellHeight);
      }
    }
    // ...and now and then a bit of the picture itself flips.
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      if (!shown(column, row) || hash(column, row, frame.tick) >= 0.012) continue;
      draw(column, row, frame.tick);
      scanlines(PAD + column * cellWidth, PAD + row * cellHeight, cellWidth, cellHeight);
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
    const lineWork = (cell: number) => cells.line[cell] > 0.2 || eyes.has(cell);
    const shown = (cell: number) => cells.coverage[cell] >= (lineWork(cell) ? 0.25 : 0.55);
    /** Draws one cell. A `variant` above 0 shows it still encrypted: a random cipher character. */
    const draw = (column: number, row: number, variant: number) => {
      const cell = row * columns + column, tone = cells.tone[cell], edge = lineWork(cell);
      const surface = edge ? outline : tone > 0.9 ? bright : tone > 0.58 ? body : shade;
      const depth = clamp(0.62 + light(column / columns, row / rows) * 0.55 + (tone > 0.58 ? 0.12 : -0.12));
      const x = PAD + column * cellWidth, y = top + row * cellHeight;
      // A dim tint behind each character joins the rows into one surface.
      context.clearRect(x, y, cellWidth, cellHeight);
      context.fillStyle = css(mix(background, surface, edge ? 0.2 : 0.14 + depth * 0.14));
      context.fillRect(x, y, cellWidth, cellHeight);
      context.fillStyle = css(variant ? mix(surface, WHITE, 0.7) : edge ? mix(background, surface, 0.92) : mix(mix(background, surface, 0.72), surface, depth));
      const glyph = variant ? CIPHER[Math.floor(hash(column, row, 400 + variant) * CIPHER.length)]
        : eyes.has(cell) ? 'o' : edge ? strokeFor(cells.angle[cell], cells.height[cell]) : RAMP[Math.min(RAMP.length - 1, 2 + Math.floor(depth * (RAMP.length - 2)))];
      context.fillText(glyph, x + cellWidth / 2, y + cellHeight / 2 + 0.5);
    };
    for (let row = 0; row < Math.ceil(frame.reveal * rows); row++) for (let column = 0; column < columns; column++) if (shown(row * columns + column)) draw(column, row, 0);
    bloom(canvas, 4, 0.3);
    if (!idle(frame)) return;
    // Idle effect: decryption that never quite finishes. On every step a few characters
    // fall back to cipher text, bright and random, and resolve again on the next.
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const cell = row * columns + column;
      if (shown(cell) && !lineWork(cell) && hash(column, row, 500 + frame.tick) < 0.03) draw(column, row, frame.tick);
    }
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
    const solid = (column: number, row: number) => column >= 0 && row >= 0 && column < columns && row < rows
      && (cells.coverage[row * columns + column] >= 0.5 || cells.line[row * columns + column] >= 0.2);
    const filled = (column: number, row: number) => solid(column, row) && (solid(column - 1, row) || solid(column + 1, row) || solid(column, row - 1) || solid(column, row + 1));
    const printed = Math.ceil(frame.reveal * rows);
    for (let row = 0; row < printed; row++) for (let column = 0; column < columns; column++) {
      if (!filled(column, row)) continue;
      const cell = row * columns + column;
      const outline = cells.line[cell] > 0.3 || cells.coverage[cell] < 0.5;
      const tone = outline ? 0 : clamp(cells.tone[cell] * 1.02 + light(column / columns, row / rows) * 0.3);
      const scaled = tone * (tones.length - 1), lower = Math.min(tones.length - 2, Math.floor(scaled));
      // Five shades per colour pair, as with the space, light, medium, dark and full block characters.
      const shade = Math.round((scaled - lower) * 4) / 4;
      for (let py = 0; py < size; py += 2) for (let px = 0; px < size; px += 2) {
        context.fillStyle = css(tones[shade > BAYER[(py >> 1) & 3][(px >> 1) & 3] ? lower + 1 : lower]);
        context.fillRect(PAD + column * size + px, PAD + row * size + py, 2, 2);
      }
    }
    bloom(canvas, 6, 0.18);
    // The cursor that printed the art: it follows the last printed row, then rests after
    // the final block and blinks.
    let last = Math.min(printed, rows) - 1;
    while (last > 0 && !Array.from({ length: columns }, (_, column) => filled(column, last)).some(Boolean)) last--;
    let end = columns - 1;
    while (end > 0 && !filled(end, last)) end--;
    if (last >= 0 && frame.reveal > 0 && (!idle(frame) || frame.tick % 4 < 2)) {
      context.fillStyle = css(bright);
      context.fillRect(PAD + (end + 1) * size + 2, PAD + (last - 1) * size, size, size * 2);
    }
    if (!idle(frame) || hash(frame.tick, 1, 70) >= 0.38) return;
    // Idle effect: a redraw glitch. For one step the terminal prints a raw colour escape
    // code where it should have painted the blocks.
    const spans: [number, number][] = [];
    for (let row = 0; row < rows - 1; row += 2) for (let column = 0; column + ESCAPE_CELLS <= columns; column++) {
      if (Array.from({ length: ESCAPE_CELLS }, (_, offset) => filled(column + offset, row) && filled(column + offset, row + 1)).every(Boolean)) spans.push([column, row]);
    }
    if (!spans.length) return;
    const [column, row] = spans[Math.floor(hash(frame.tick, 2, 70) * spans.length)];
    const x = PAD + column * size, y = PAD + row * size;
    context.fillStyle = css(background);
    context.fillRect(x, y, ESCAPE_CELLS * size, size * 2);
    context.font = "700 13px 'Card Mono', monospace";
    context.textBaseline = 'middle';
    context.textAlign = 'left';
    context.fillStyle = css(hex(colors.fg));
    context.fillText(`^[[38;5;${16 + Math.floor(hash(frame.tick, 3, 70) * 216)}m`, x + 3, y + size + 1);
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
