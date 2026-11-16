// The avatar as a piece of terminal-era art: cut out, given depth and light, then drawn in one of four styles.
import { cutOut } from './cutout.js';
import { relief, reliefCells, type ReliefCells } from './relief.js';
import type { ColorToken, PortraitStyle } from './types.js';

type Colors = Record<ColorToken, string>;
type RGB = [number, number, number];
export interface PortraitFrame {
  /** Idle animation step. 0 is the portrait at rest; every hold frame after that moves it a little. */
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

/** The subject is drawn this wide, inside a margin that leaves room for glow and flares. */
const INNER = 408, PAD = 16, MAX_HEIGHT = 416;
const HOT: RGB = [255, 248, 228];

const hex = (color: string): RGB => [1, 3, 5].map(index => parseInt(color.slice(index, index + 2), 16)) as RGB;
const clamp = (value: number, low = 0, high = 1) => Math.max(low, Math.min(high, value));
const mix = (from: RGB, to: RGB, amount: number): RGB => from.map((value, index) => value + (to[index] - value) * clamp(amount)) as RGB;
const css = (color: RGB, alpha = 1) => `rgba(${color.map(value => Math.round(clamp(value, 0, 255))).join(',')},${alpha})`;
/** Pushes a colour away from grey, so muted themes still give saturated light. */
const vivid = (color: RGB, amount: number): RGB => { const grey = (color[0] + color[1] + color[2]) / 3; return color.map(value => grey + (value - grey) * amount) as RGB; };
/** A colour from evenly spaced stops. */
function gradient(stops: RGB[], position: number): RGB {
  const scaled = clamp(position) * (stops.length - 1), lower = Math.min(stops.length - 2, Math.floor(scaled));
  return mix(stops[lower], stops[lower + 1], scaled - lower);
}
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
/** Adds a blurred copy of the drawing on top of itself: light bleeding out of the bright parts. */
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
/** Brightness of a lit cell or pixel: flat colour times light, plus the highlight. Line work stays dark. */
const lit = (cells: Pick<ReliefCells, 'albedo' | 'shade' | 'depth' | 'gloss' | 'line'>, index: number) =>
  clamp(cells.albedo[index] * (0.3 + 0.95 * cells.shade[index]) * (0.7 + 0.3 * cells.depth[index]) + cells.gloss[index] * 0.85) * (1 - clamp(cells.line[index] * 1.5) * 0.82);

export async function loadPortrait(source: string): Promise<Portrait> {
  const image = new Image();
  image.src = source;
  await image.decode();
  const [full, fullContext] = makeCanvas(image.naturalWidth, image.naturalHeight);
  fullContext.drawImage(image, 0, 0);
  const pixels = fullContext.getImageData(0, 0, full.width, full.height);
  const { box } = cutOut(pixels.data, full.width, full.height);
  fullContext.putImageData(pixels, 0, 0);
  const innerHeight = Math.min(MAX_HEIGHT, Math.round(INNER * box.height / box.width / 24) * 24);
  const [, subjectContext] = makeCanvas(INNER, innerHeight);
  subjectContext.imageSmoothingQuality = 'high';
  subjectContext.drawImage(full, box.left, box.top, box.width, box.height, 0, 0, INNER, innerHeight);
  const lighting = relief(subjectContext.getImageData(0, 0, INNER, innerHeight).data, INNER, innerHeight);
  const width = INNER + PAD * 2, height = innerHeight + PAD * 2;

  const grids = new Map<string, ReliefCells>();
  function grid(columns: number, rows: number): ReliefCells {
    const key = `${columns}x${rows}`;
    if (!grids.has(key)) grids.set(key, reliefCells(lighting, columns, rows));
    return grids.get(key)!;
  }
  // The two strongest highlights, well apart: where the lens flares sit.
  const flares: { x: number; y: number }[] = [];
  for (let pass = 0; pass < 2; pass++) {
    let best = -1, strength = 0.2;
    for (let index = 0; index < lighting.gloss.length; index++) {
      const x = index % INNER, y = (index - x) / INNER;
      if (lighting.gloss[index] * lighting.albedo[index] > strength && flares.every(flare => Math.hypot(flare.x - x, flare.y - y) > INNER * 0.3)) { best = index; strength = lighting.gloss[index] * lighting.albedo[index]; }
    }
    if (best >= 0) flares.push({ x: best % INNER, y: Math.floor(best / INNER) });
  }

  // Every style draws the portrait at rest, lets the light bloom, and only then adds its
  // idle effect as small crisp touches. Blooming the effect too would smear every change
  // across the picture and make each animation frame many times heavier.
  const idle = (frame: PortraitFrame) => frame.tick > 0 && frame.reveal === 1;

  /** LED matrix: one round lamp per cell in a single warm colour, brightness carrying the picture. */
  function led(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const pitch = 8, columns = INNER / pitch, rows = innerHeight / pitch;
    const cells = grid(columns, rows);
    const amber = vivid(hex(colors.orange), 1.3), dark = mix(hex(colors.bg), amber, 0.1);
    const lamp = (column: number, row: number, radius: number, color: RGB) => {
      context.fillStyle = css(color);
      context.beginPath();
      context.arc(column * pitch + pitch / 2, row * pitch + pitch / 2, radius, 0, Math.PI * 2);
      context.fill();
    };
    const lampAt = (column: number, row: number, level: number) => {
      const step = Math.round(level * 8) / 8;
      lamp(column + PAD / pitch, row + PAD / pitch, 2.5 + step * 1.1, step < 0.78 ? mix(dark, amber, step / 0.78) : mix(amber, HOT, (step - 0.78) / 0.22));
    };
    const level = (cell: number) => clamp(lit(cells, cell) * 0.98 + cells.rim[cell] * 0.5) * Math.min(1, cells.alpha[cell] * 1.4);
    // The unlit panel.
    for (let row = 0; row < height / pitch; row++) for (let column = 0; column < width / pitch; column++) lamp(column, row, 2.3, dark);
    for (let row = 0; row < Math.ceil(frame.reveal * rows); row++) for (let column = 0; column < columns; column++) {
      if (cells.alpha[row * columns + column] >= 0.35) lampAt(column, row, level(row * columns + column));
    }
    bloom(canvas, 7, 0.7);
    if (!idle(frame)) return;
    // Idle effect: the panel flickers. On every step a few lamps dip and a few flare.
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const cell = row * columns + column, chance = hash(column, row, frame.tick), bright = level(cell);
      if (cells.alpha[cell] < 0.35 || bright < 0.3 || (chance >= 0.035 && chance <= 0.985)) continue;
      lamp(column + PAD / pitch, row + PAD / pitch, 4, mix(dark, amber, 0.12));
      lampAt(column, row, chance < 0.035 ? bright * 0.45 : 1);
    }
  }

  /** Halftone print: dots that grow with brightness, in two inks slightly out of register. */
  function halftone(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const pitch = 6, columns = INNER / pitch, rows = innerHeight / pitch;
    const cells = grid(columns, rows);
    const background = hex(colors.bg);
    const warm = [colors.red, colors.orange, colors.yellow].map(color => vivid(hex(color), 1.25)).concat([HOT]);
    const cool = [mix(background, hex(colors.blue), 0.7), vivid(hex(colors.blue), 1.2), vivid(hex(colors.cyan), 1.2), hex(colors.fgBright)];
    const shadowInk = mix(background, vivid(hex(colors.magenta), 1.3), 0.55), rimInk = vivid(hex(colors.magenta), 1.35);
    const grow = 1 - (1 - frame.reveal) ** 2;
    const dot = (x: number, y: number, radius: number, color: RGB) => {
      if (radius < 0.35) return;
      context.fillStyle = css(color);
      context.beginPath();
      context.arc(x, y, radius, 0, Math.PI * 2);
      context.fill();
    };
    /** Draws one cell's dot, `swell` times its resting size. */
    const print = (column: number, row: number, layer: 'shadow' | 'ink', swell: number) => {
      const cell = row * columns + column;
      if (cells.alpha[cell] < 0.3) return;
      const light = clamp(lit(cells, cell) * 1.12);
      // Every other row is shifted half a step, as on a printing screen.
      const x = PAD + column * pitch + pitch / 2 + (row % 2 ? pitch / 2 : 0), y = PAD + row * pitch + pitch / 2;
      const radius = (0.7 + 2.7 * Math.sqrt(light)) * Math.min(1, cells.alpha[cell] * 1.5) * grow * swell;
      if (layer === 'shadow') return dot(x + 1.6, y + 1.6, radius * 0.95, shadowInk);
      const surface = gradient(cells.albedo[cell] > 0.58 ? warm : cool, Math.pow(light, 1.3));
      dot(x, y, radius, mix(mix(surface, rimInk, cells.rim[cell] * 1.6), HOT, cells.gloss[cell] * 0.8 + (swell - 1) * 0.9));
    };
    for (const layer of ['shadow', 'ink'] as const) for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) print(column, row, layer, 1);
    bloom(canvas, 5, 0.3);
    if (!idle(frame)) return;
    // Idle effect: the print breathes. A thin ring of swollen dots travels out from the
    // middle during the first steps of every hold.
    const phase = (frame.tick - 1) % 10;
    if (phase > 5) return;
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const distance = Math.hypot(column / columns - 0.5, (row / rows - 0.5) * rows / columns) * 2;
      const breath = 1 - Math.abs(distance - phase / 5 * 1.15) / 0.075;
      if (breath > 0) print(column, row, 'ink', 1 + breath * 0.3);
    }
  }

  const POOLS = { dim: "·.:'`,-", text: '=+*cxzo%#&@$', shape: '╱╲╳┼▚▞◆◇○●■□', block: '░▒▓█▓▒', spark: '*+×◆●' };
  /** Mixed glyphs: several character pools blended per cell, gold light and cyan shade, blocky cut-out edges. */
  function glyphs(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const cellWidth = 6, cellHeight = 12, columns = INNER / cellWidth, rows = innerHeight / cellHeight;
    const cells = grid(columns, rows);
    const background = hex(colors.bg), blue = vivid(hex(colors.blue), 1.2), cyan = vivid(hex(colors.cyan), 1.3);
    const gold = [mix(background, vivid(hex(colors.orange), 1.3), 0.5), vivid(hex(colors.orange), 1.3), vivid(hex(colors.yellow), 1.3), HOT];
    const sea = [mix(background, blue, 0.45), blue, cyan, hex(colors.fgBright)];
    context.font = "700 11px 'Card Mono', monospace";
    context.textBaseline = 'middle';
    context.textAlign = 'center';
    // One character lattice for the whole canvas, placed so the subject's cells fall on it.
    const originX = PAD % cellWidth, originY = PAD % cellHeight, offsetX = Math.floor(PAD / cellWidth), offsetY = Math.floor(PAD / cellHeight);
    const totalColumns = Math.floor((width - originX) / cellWidth), totalRows = Math.floor((height - originY) / cellHeight);
    const put = (column: number, row: number, glyph: string, color: RGB, fill: RGB) => {
      const x = originX + column * cellWidth, y = originY + row * cellHeight;
      context.fillStyle = css(fill);
      context.fillRect(x, y, cellWidth, cellHeight);
      context.fillStyle = css(color);
      context.fillText(glyph, x + cellWidth / 2, y + cellHeight / 2 + 0.5);
    };
    const pick = (pool: string, column: number, row: number, seed: number) => pool[Math.floor(hash(column, row, 60 + seed) * pool.length)];
    // Cut-out panels behind the subject, a dim seascape with a glowing horizon.
    const panels = [[0, 0.16, 0.3, 0.6], [0.72, 0.36, 1, 0.84]];
    for (const [left, top, right, bottom] of panels) {
      const horizon = Math.round((top + (bottom - top) * 0.55) * totalRows);
      for (let row = Math.round(top * totalRows); row < Math.round(bottom * totalRows); row++) for (let column = Math.round(left * totalColumns); column < Math.round(right * totalColumns); column++) {
        if (hash(column, row, 8) > Math.min(1, frame.reveal * 1.5)) continue;
        const glow = row === horizon ? 1 : Math.max(0, 1 - Math.abs(row - horizon) / 3);
        const tone = mix(mix(background, row < horizon ? cyan : blue, 0.16 + hash(column, row, 9) * 0.18), gold[1], glow * (0.2 + hash(column, row, 10) * 0.35));
        put(column, row, pick(row === horizon ? POOLS.block : hash(column, row, 11) < 0.5 ? POOLS.dim : POOLS.text, column, row, 0), tone, mix(background, tone, 0.18));
      }
    }
    // The silhouette snaps to blocks two cells wide, like paper cut with a ruler.
    const inside = (column: number, row: number) => { const pair = row * columns + (column & ~1); return Math.max(cells.alpha[pair], cells.alpha[pair + 1]) >= 0.3; };
    /** Draws one cell of the subject. `seed` picks among the looks the cell can take. */
    const cell = (column: number, row: number, seed: number) => {
      const index = row * columns + column, covered = cells.alpha[index] >= 0.3;
      const light = covered ? lit(cells, index) : 0.08, jitter = light + (hash(column, row, 12) - 0.5) * 0.22;
      // Lit surfaces are gold or sea blue; the side turned from the light cools towards cyan.
      let color = covered ? mix(gradient(cells.albedo[index] > 0.58 ? gold : sea, Math.pow(light, 0.8) * 1.05), cyan, cells.rim[index] * 1.8 + (cells.shade[index] < 0.45 ? 0.35 : 0)) : mix(background, blue, 0.5);
      let glyph = pick(jitter < 0.2 ? POOLS.dim : jitter < 0.45 ? POOLS.text : jitter < 0.66 ? POOLS.shape : POOLS.block, column, row, seed);
      if (covered && cells.gloss[index] > 0.22 && hash(column, row, 13 + seed) < 0.55) { glyph = pick(POOLS.spark, column, row, seed); color = HOT; }
      put(column + offsetX, row + offsetY, glyph, color, mix(background, color, covered ? 0.1 + light * 0.22 : 0.12));
    };
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      if (inside(column, row) && (frame.reveal === 1 || hash(column, row, 7) <= frame.reveal * 1.2)) cell(column, row, 0);
    }
    bloom(canvas, 5, 0.42);
    if (!idle(frame)) return;
    // Idle effect: the texture shimmers. On every step a few cells redraw from their pool,
    // and the sparkles on the highlights change places.
    for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
      const index = row * columns + column;
      if (inside(column, row) && (cells.gloss[index] > 0.22 ? hash(column, row, 40 + (frame.tick >> 1)) < 0.5 : hash(column, row, 50 + frame.tick) < 0.035)) cell(column, row, frame.tick);
    }
  }

  // The mirror ball: which tile each canvas pixel falls on, and how near the tile's edge.
  const SPHERE = width * 0.66, TILE = 0.034;
  const tileOf = new Int32Array(width * height), grout = new Uint8Array(width * height);
  const tiles = new Map<number, { light: number; rim: number; warm: number; weight: number; pixels: number }>();
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const ny = clamp((y - height / 2) / SPHERE, -0.999, 0.999), nx = (x - width / 2) / SPHERE;
    const longitude = Math.asin(clamp(nx / Math.sqrt(1 - ny * ny), -1, 1)) / TILE, latitude = Math.asin(ny) / TILE;
    const index = y * width + x, id = (Math.floor(longitude) + 512) * 1024 + Math.floor(latitude) + 512;
    tileOf[index] = id;
    grout[index] = longitude - Math.floor(longitude) < 0.16 || latitude - Math.floor(latitude) < 0.2 ? 1 : 0;
    const sum = tiles.get(id) ?? { light: 0, rim: 0, warm: 0, weight: 0, pixels: 0 };
    sum.pixels++;
    const sx = x - PAD, sy = y - PAD;
    if (sx >= 0 && sy >= 0 && sx < INNER && sy < innerHeight) {
      const pixel = sy * INNER + sx, opacity = lighting.alpha[pixel];
      sum.light += lit(lighting, pixel) * opacity; sum.rim += lighting.rim[pixel] * opacity; sum.warm += (lighting.albedo[pixel] > 0.58 ? 1 : 0) * opacity; sum.weight += opacity;
    }
    tiles.set(id, sum);
  }

  /** Disco ball: the picture as glitter tiles on a mirror sphere, overexposed, with scanlines and lens flares. */
  function disco(canvas: HTMLCanvasElement, colors: Colors, frame: PortraitFrame): void {
    const context = canvas.getContext('2d')!;
    const black = mix(hex(colors.bg), [0, 0, 0], 0.5), cyan = vivid(hex(colors.cyan), 1.4), deep = mix(black, vivid(hex(colors.blue), 1.4), 0.78);
    // Heat: from black through the theme's deep and hot colours to white.
    const heat = [black, deep, vivid(hex(colors.magenta), 1.4), vivid(hex(colors.red), 1.45), vivid(hex(colors.orange), 1.4), vivid(hex(colors.yellow), 1.3), HOT, [255, 255, 255] as RGB];
    const cold = [black, deep, vivid(hex(colors.blue), 1.3), cyan, HOT];
    const visible = (id: number) => { const sum = tiles.get(id)!; return sum.weight / sum.pixels >= 0.3 && hash(id >> 10, id & 1023, 5) <= frame.reveal * 1.2; };
    // Idle effect, part one: on every step a few mirror tiles catch the light and flash white.
    const glinting = (id: number) => idle(frame) && hash(id >> 10, id & 1023, 20 + frame.tick) < 0.035;
    /** Paints the tiles `wanted` picks. Grout and scanlines darken them unless they are `flat`. */
    const paint = (wanted: (id: number) => boolean, tint: (id: number) => RGB, flat = false) => {
      const [layer, layerContext] = makeCanvas(width, height);
      const image = layerContext.createImageData(width, height), tints = new Map<number, RGB | null>();
      for (let index = 0; index < tileOf.length; index++) {
        const id = tileOf[index];
        if (!tints.has(id)) tints.set(id, visible(id) && wanted(id) ? tint(id) : null);
        const color = tints.get(id);
        if (!color) continue;
        const dim = flat ? 1 : (grout[index] ? 0.3 : 1) * (Math.floor(index / width) % 3 === 2 ? 0.7 : 1);
        image.data.set([color[0] * dim, color[1] * dim, color[2] * dim, 255], index * 4);
      }
      layerContext.putImageData(image, 0, 0);
      context.drawImage(layer, 0, 0);
    };
    paint(() => true, id => {
      // Each mirror tile catches the light a little differently.
      const sum = tiles.get(id)!, facet = 0.8 + hash(id >> 10, id & 1023, 6) * 0.45;
      const light = clamp(Math.pow(sum.light / sum.weight, 0.72) * 1.06 * facet);
      return mix(gradient(sum.warm / sum.weight > 0.5 ? heat : cold, light), cyan, sum.rim / sum.weight * 2.2);
    });
    bloom(canvas, 9, 0.75);
    if (frame.reveal < 1) return;
    paint(glinting, () => [255, 255, 255], true);
    // Lens flares on the strongest highlights. Idle effect, part two: they breathe and turn.
    context.save();
    context.globalCompositeOperation = 'lighter';
    flares.forEach((flare, number) => {
      const pulse = frame.tick > 0 ? 0.5 + 0.5 * Math.sin(frame.tick * 1.1 + number * 2) : 0.5;
      const x = PAD + flare.x, y = PAD + flare.y, reach = (number ? 44 : 70) * (0.8 + pulse * 0.45);
      const core = context.createRadialGradient(x, y, 0, x, y, reach * 0.3);
      core.addColorStop(0, css([255, 255, 255], 0.95)); core.addColorStop(1, css(HOT, 0));
      context.fillStyle = core;
      context.fillRect(x - reach, y - reach, reach * 2, reach * 2);
      for (let ray = 0; ray < 4; ray++) {
        const angle = ray * Math.PI / 4 + (frame.tick > 0 ? Math.sin(frame.tick * 0.7 + number) * 0.12 : 0), length = reach * (ray % 2 ? 0.55 : 1);
        const dx = Math.cos(angle) * length, dy = Math.sin(angle) * length;
        const beam = context.createLinearGradient(x - dx, y - dy, x + dx, y + dy);
        beam.addColorStop(0, css(HOT, 0)); beam.addColorStop(0.5, css([255, 255, 255], 0.9)); beam.addColorStop(1, css(HOT, 0));
        context.strokeStyle = beam;
        context.lineWidth = ray % 2 ? 1.5 : 2.5;
        context.beginPath(); context.moveTo(x - dx, y - dy); context.lineTo(x + dx, y + dy); context.stroke();
      }
    });
    context.restore();
  }

  return {
    width, height,
    draw(canvas, style, colors, frame) {
      canvas.width = width;
      canvas.height = height;
      ({ disco, halftone, glyphs, led })[style](canvas, colors, frame);
    },
  };
}
