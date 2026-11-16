import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { cutOut } from './scene/cutout.js';
import { relief, reliefCells } from './scene/relief.js';

type Color = [number, number, number];
/** A width x height RGBA image where `paint` returns the colour of each pixel. */
function image(width: number, height: number, paint: (x: number, y: number) => Color): Uint8ClampedArray {
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set([...paint(x, y), 255], (y * width + x) * 4);
  return rgba;
}
const SKY: Color = [110, 198, 245], FUR: Color = [181, 167, 155], INK: Color = [75, 46, 22], WHITE: Color = [255, 255, 255];
const alphaAt = (rgba: Uint8ClampedArray, width: number, x: number, y: number) => rgba[(y * width + x) * 4 + 3];
/** Sizes of the 8-connected groups of opaque pixels, largest first. */
function parts(rgba: Uint8ClampedArray, width: number, height: number): number[] {
  const seen = new Uint8Array(width * height), sizes: number[] = [], stack: number[] = [];
  for (let start = 0; start < seen.length; start++) {
    if (seen[start] || rgba[start * 4 + 3] < 128) continue;
    let size = 0;
    seen[start] = 1; stack.push(start);
    while (stack.length) {
      const index = stack.pop()!, x = index % width, y = (index - x) / width;
      size++;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx >= 0 && ny >= 0 && nx < width && ny < height && !seen[next] && rgba[next * 4 + 3] >= 128) { seen[next] = 1; stack.push(next); }
      }
    }
    sizes.push(size);
  }
  return sizes.sort((a, b) => b - a);
}

test('cut-out keeps the subject and drops the background, its ring and stray specks', () => {
  const size = 120;
  const rgba = image(size, size, (x, y) => {
    const radius = Math.hypot(x - 60, y - 60);
    if (Math.hypot(x - 60, y - 66) < 30) return Math.hypot(x - 60, y - 66) > 26 ? INK : FUR; // outlined subject
    if (radius > 52 && radius < 56) return WHITE;                                             // decorative ring
    if ((x === 12 && y === 12) || (x > 100 && x < 104 && y > 20 && y < 24)) return INK;       // specks
    return SKY;
  });
  const { keyed, box } = cutOut(rgba, size, size);
  assert.equal(keyed, true);
  assert.deepEqual(parts(rgba, size, size).length, 1, 'one connected subject, nothing stray');
  assert.equal(alphaAt(rgba, size, 60, 66), 255);
  for (const [x, y] of [[0, 0], [60, 6], [12, 12], [102, 22], [60, 114]]) assert.equal(alphaAt(rgba, size, x, y), 0, `${x},${y} is cleared`);
  assert.ok(box.left >= 28 && box.left <= 31 && box.top >= 34 && box.top <= 37 && box.width >= 59 && box.width <= 63 && box.height >= 59 && box.height <= 63, JSON.stringify(box));
});

test('cut-out leaves an avatar without a flat background whole', () => {
  const size = 64;
  const photo = image(size, size, (x, y) => [(x * 37 + y * 11) % 256, (x * 5 + y * 53) % 256, (x * 91 + y * 17) % 256]);
  const result = cutOut(photo, size, size);
  assert.deepEqual(result, { keyed: false, box: { left: 0, top: 0, width: size, height: size } });
  assert.ok(photo.every((value, index) => index % 4 !== 3 || value === 255));
  // A plain image has no subject to find; it is left whole too.
  const blank = image(size, size, () => SKY);
  assert.equal(cutOut(blank, size, size).keyed, false);
  assert.equal(alphaAt(blank, size, 10, 10), 255);
});

test('cut-out of the fixture avatar is one clean subject', async () => {
  const fixture = JSON.parse(await readFile('fixtures/profile.json', 'utf8')) as { avatar: string };
  const { data, info } = await sharp(Buffer.from(fixture.avatar.split(',')[1], 'base64')).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const rgba = new Uint8ClampedArray(data);
  const background = [rgba[0], rgba[1], rgba[2]];
  const { keyed, box } = cutOut(rgba, info.width, info.height);
  assert.equal(keyed, true);
  const sizes = parts(rgba, info.width, info.height), opaque = sizes.reduce((sum, value) => sum + value, 0);
  assert.ok(sizes[0] >= opaque * 0.999, `stray pixels: ${opaque - sizes[0]}`);
  assert.ok(opaque > info.width * info.height * 0.25 && opaque < info.width * info.height * 0.6, 'the subject is a sensible share of the image');
  assert.ok(box.width < info.width * 0.95 && box.height < info.height * 0.85, 'cropped to the subject, without the ring');
  for (let index = 0; index < rgba.length; index += 4) {
    const edge = index / 4 % info.width < 3 || index / 4 < info.width * 3;
    if (edge) assert.equal(rgba[index + 3], 0, 'the image border is cleared');
    // No solid pixel still carries the background colour.
    if (rgba[index + 3] === 255) assert.ok(Math.hypot(rgba[index] - background[0], rgba[index + 1] - background[1], rgba[index + 2] - background[2]) > 36);
  }
});

/** A flat grey disc on a transparent ground, optionally split by a dark vertical line. */
function disc(size: number, split = false): Uint8ClampedArray {
  const rgba = image(size, size, x => (split && Math.abs(x - size / 2) < 2 ? INK : FUR));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (Math.hypot(x - size / 2, y - size / 2) > size * 0.4) rgba[(y * size + x) * 4 + 3] = 0;
  return rgba;
}

test('relief turns a flat shape into a lit dome', () => {
  const size = 100, lit = relief(disc(size), size, size);
  const at = (field: Float32Array, x: number, y: number) => field[y * size + x];
  // Every pixel of the flat disc has the same colour; the light is what differs.
  assert.equal(at(lit.albedo, 30, 30), at(lit.albedo, 70, 70));
  assert.ok(at(lit.shade, 30, 30) > at(lit.shade, 50, 50) && at(lit.shade, 50, 50) > at(lit.shade, 70, 70), 'lit from the top left');
  assert.ok(at(lit.rim, 77, 77) > 0.15 && at(lit.rim, 23, 23) === 0 && at(lit.rim, 50, 50) === 0, 'rim light on the far edge only');
  let brightest = 0;
  for (let index = 0; index < lit.gloss.length; index++) if (lit.gloss[index] > lit.gloss[brightest]) brightest = index;
  assert.ok(brightest % size < 50 && Math.floor(brightest / size) < 50, 'the highlight sits towards the light');
  assert.ok(at(lit.depth, 50, 50) === 1 && at(lit.depth, 50, 12) < 0.4 && at(lit.alpha, 2, 2) === 0);
  for (const field of [lit.alpha, lit.albedo, lit.shade, lit.gloss, lit.rim, lit.depth, lit.line]) assert.ok(field.every(value => value >= 0 && value <= 1));
  assert.throws(() => relief(new Uint8ClampedArray(16), size, size));
});

test('an outline splits the relief into separate shapes', () => {
  const size = 100, whole = relief(disc(size), size, size), split = relief(disc(size, true), size, size);
  const middle = 50 * size + 50, beside = 50 * size + 56;
  assert.equal(split.line[middle], 1);
  assert.equal(whole.line[middle], 0);
  assert.equal(split.depth[middle], 0);
  assert.ok(split.depth[beside] < whole.depth[beside], 'the surface dips towards the line');
  // Each half is a dome of its own: just right of the line the surface faces left, into the light.
  assert.ok(split.shade[beside] > whole.shade[beside]);
});

test('relief cells average over the covered part of each cell', () => {
  const size = 100, cells = reliefCells(relief(disc(size, true), size, size), 10, 10);
  assert.equal(cells.columns, 10);
  assert.equal(cells.alpha[0], 0);
  assert.equal(cells.alpha[55], 1);
  assert.ok(cells.alpha[12] > 0 && cells.alpha[12] < 1, 'a cell on the edge is partly covered');
  assert.ok(cells.line[54] > 0.1 && cells.line[57] === 0);
  assert.ok(cells.albedo[57] > 0.6 && cells.albedo[57] < 0.8);
});
