import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import sharp from 'sharp';
import { cellStats, findSpots, strokeFor, SUPER } from './scene/cells.js';
import { cutOut } from './scene/cutout.js';

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
  // The two eyes are the only small round dark spots.
  const crop = new Uint8ClampedArray(box.width * box.height * 4);
  for (let y = 0; y < box.height; y++) crop.set(rgba.subarray(((box.top + y) * info.width + box.left) * 4, ((box.top + y) * info.width + box.left + box.width) * 4), y * box.width * 4);
  const eyes = findSpots(crop, box.width, box.height);
  assert.equal(eyes.length, 2);
  assert.ok(eyes.every(eye => eye.y < 0.35) && Math.abs(eyes[0].x - eyes[1].x) > 0.08);
});

test('cells report coverage, tone and the direction of line work', () => {
  // Each pattern sits in the middle cell of a 3x3 grid of plain fur.
  const side = SUPER * 3;
  const middle = (paint: (x: number, y: number) => Color | null) => {
    const fine = image(side, side, (x, y) => (x >= SUPER && x < SUPER * 2 && y >= SUPER && y < SUPER * 2 ? paint(x - SUPER, y - SUPER) ?? FUR : FUR));
    for (let y = 0; y < SUPER; y++) for (let x = 0; x < SUPER; x++) if (paint(x, y) === null) fine[((y + SUPER) * side + x + SUPER) * 4 + 3] = 0;
    const cells = cellStats(fine, 3, 3);
    return { coverage: cells.coverage[4], tone: cells.tone[4], line: cells.line[4], stroke: strokeFor(cells.angle[4], cells.height[4]) };
  };
  assert.deepEqual(middle(() => FUR), { coverage: 1, tone: middle(() => FUR).tone, line: 0, stroke: middle(() => FUR).stroke });
  assert.ok(middle(() => FUR).tone > 0.6 && middle(() => FUR).tone < 0.8);
  assert.ok(middle(() => WHITE).tone > middle(() => FUR).tone);
  assert.equal(middle(x => (x < 2 ? null : FUR)).coverage, 0.5);
  assert.equal(middle(() => null).coverage, 0);
  const upright = middle(x => (x === 1 ? INK : FUR));
  assert.equal(upright.stroke, '|');
  assert.equal(upright.line, 0.25);
  assert.equal(middle((_, y) => (y === 3 ? INK : FUR)).stroke, '_');
  assert.equal(middle((_, y) => (y === 0 ? INK : FUR)).stroke, '¯');
  assert.equal(middle((x, y) => (x === y ? INK : FUR)).stroke, '\\');
  assert.equal(middle((x, y) => (x === SUPER - 1 - y ? INK : FUR)).stroke, '/');
  assert.equal(strokeFor(170, 0.5), '-');
  assert.throws(() => cellStats(new Uint8ClampedArray(16), 3, 3));
});

test('spots are small round dark shapes, not strokes or large areas', () => {
  const size = 100;
  const rgba = image(size, size, (x, y) => {
    if (Math.hypot(x - 30, y - 30) < 3.2) return INK;      // an eye
    if (y === 60 && x > 10 && x < 60) return INK;          // a whisker
    if (x > 70 && y > 70) return INK;                      // a large dark area
    return FUR;
  });
  const spots = findSpots(rgba, size, size);
  assert.equal(spots.length, 1);
  assert.ok(Math.abs(spots[0].x - 0.305) < 0.02 && Math.abs(spots[0].y - 0.305) < 0.02);
});
