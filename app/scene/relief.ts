// Gives a flat cartoon depth: every outlined shape is puffed into a soft relief and lit.
// Pure pixel maths, no DOM.

export interface Relief {
  width: number;
  height: number;
  /** Subject coverage, 0-1. */
  alpha: Float32Array;
  /** Brightness of the flat artwork itself, 0-1, gamma-lifted. */
  albedo: Float32Array;
  /** Diffuse light from the top left, 0-1. A surface facing the viewer gets about 0.66. */
  shade: Float32Array;
  /** Specular highlight, 0-1. */
  gloss: Float32Array;
  /** Rim light on edges that face away from the main light, 0-1. */
  rim: Float32Array;
  /** How far inside its shape a pixel is: 0 on an outline, 1 in the middle of a surface. */
  depth: Float32Array;
  /** 1 where the artwork has an outline or other dark line work (eyes, whiskers). */
  line: Float32Array;
}

/** Opaque pixels darker than this are outlines: they separate one puffed shape from the next. */
const OUTLINE = 0.3;
const LIGHT = normalize(-0.45, -0.6, 0.66);
const HALF = normalize(LIGHT[0], LIGHT[1], LIGHT[2] + 1);

function normalize(x: number, y: number, z: number): [number, number, number] {
  const length = Math.hypot(x, y, z);
  return [x / length, y / length, z / length];
}

function blur(values: Float32Array, width: number, height: number, radius: number): Float32Array {
  const pass = (source: Float32Array, stepX: number, stepY: number) => {
    const target = new Float32Array(source.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let sum = 0, count = 0;
      for (let offset = -radius; offset <= radius; offset++) {
        const nx = x + offset * stepX, ny = y + offset * stepY;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height) { sum += source[ny * width + nx]; count++; }
      }
      target[y * width + x] = sum / count;
    }
    return target;
  };
  return pass(pass(values, 1, 0), 0, 1);
}

/** `rgba` is the cut-out subject with transparency where the background was. */
export function relief(rgba: Uint8ClampedArray, width: number, height: number): Relief {
  const count = width * height;
  if (rgba.length !== count * 4) throw new Error('Subject pixels do not match the given size');
  const alpha = new Float32Array(count), albedo = new Float32Array(count), distance = new Float32Array(count), line = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    const offset = index * 4;
    const brightness = (rgba[offset] * 0.2126 + rgba[offset + 1] * 0.7152 + rgba[offset + 2] * 0.0722) / 255;
    alpha[index] = rgba[offset + 3] / 255;
    albedo[index] = Math.pow(brightness, 0.85);
    line[index] = alpha[index] >= 0.5 && brightness < OUTLINE ? 1 : 0;
    distance[index] = alpha[index] < 0.5 || line[index] ? 0 : Infinity;
  }
  // Two-pass chamfer distance to the nearest outline or edge of the subject.
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= width || y >= height ? 0 : distance[y * width + x]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    distance[index] = Math.min(distance[index], at(x - 1, y) + 1, at(x, y - 1) + 1, at(x - 1, y - 1) + Math.SQRT2, at(x + 1, y - 1) + Math.SQRT2);
  }
  for (let y = height - 1; y >= 0; y--) for (let x = width - 1; x >= 0; x--) {
    const index = y * width + x;
    distance[index] = Math.min(distance[index], at(x + 1, y) + 1, at(x, y + 1) + 1, at(x + 1, y + 1) + Math.SQRT2, at(x - 1, y + 1) + Math.SQRT2);
  }
  // Two rounded profiles added together: a tight bevel along every outline, and a broad
  // swell that keeps large shapes curving all the way to their middle.
  const bevel = width * 0.075, swell = width * 0.24;
  const round = (reach: number) => Math.sqrt(1 - (1 - Math.min(reach, 1)) ** 2);
  const depth = new Float32Array(count);
  let tight: Float32Array = new Float32Array(count), broad: Float32Array = new Float32Array(count);
  for (let index = 0; index < count; index++) {
    depth[index] = Math.min(distance[index] / bevel, 1);
    tight[index] = round(distance[index] / bevel);
    broad[index] = round(distance[index] / swell);
  }
  // A distance field has creases along the middle of every shape. The swell is blurred
  // until they are gone, or each crease would catch the light like a folded edge.
  tight = blur(tight, width, height, 2);
  const soften = Math.max(2, Math.round(width * 0.025));
  broad = blur(blur(blur(broad, width, height, soften), width, height, soften), width, height, soften);
  const surface = tight.map((value, index) => value + broad[index] * 1.6);
  const shade = new Float32Array(count), gloss = new Float32Array(count), rim = new Float32Array(count);
  const level = (x: number, y: number) => surface[Math.max(0, Math.min(height - 1, y)) * width + Math.max(0, Math.min(width - 1, x))];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    if (alpha[index] < 0.05) continue;
    const slope = bevel * 0.75;
    const [nx, ny, nz] = normalize(-(level(x + 1, y) - level(x - 1, y)) / 2 * slope, -(level(x, y + 1) - level(x, y - 1)) / 2 * slope, 1);
    shade[index] = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
    gloss[index] = Math.pow(Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]), 26);
    rim[index] = Math.pow(1 - nz, 1.4) * Math.max(0, nx * 0.6 + ny * 0.8);
  }
  return { width, height, alpha, albedo, shade, gloss, rim, depth, line };
}

export interface ReliefCells extends Omit<Relief, 'width' | 'height'> { columns: number; rows: number }

/** Averages the relief over a grid. `alpha` becomes the share of each cell the subject covers. */
export function reliefCells(source: Relief, columns: number, rows: number): ReliefCells {
  const count = columns * rows;
  const cells: ReliefCells = { columns, rows, alpha: new Float32Array(count), albedo: new Float32Array(count), shade: new Float32Array(count), gloss: new Float32Array(count), rim: new Float32Array(count), depth: new Float32Array(count), line: new Float32Array(count) };
  const fields = ['albedo', 'shade', 'gloss', 'rim', 'depth', 'line'] as const;
  for (let row = 0; row < rows; row++) for (let column = 0; column < columns; column++) {
    const left = Math.floor(column * source.width / columns), right = Math.max(left + 1, Math.floor((column + 1) * source.width / columns));
    const top = Math.floor(row * source.height / rows), bottom = Math.max(top + 1, Math.floor((row + 1) * source.height / rows));
    const cell = row * columns + column;
    let weight = 0;
    for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
      const index = y * source.width + x, opacity = source.alpha[index];
      weight += opacity;
      for (const field of fields) cells[field][cell] += source[field][index] * opacity;
    }
    cells.alpha[cell] = weight / ((right - left) * (bottom - top));
    if (weight) for (const field of fields) cells[field][cell] /= weight;
  }
  return cells;
}
