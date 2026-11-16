// Cuts the subject out of an avatar with a flat-colour background. Pure pixel maths, no DOM.
export interface Cutout {
  /** False when the border is not one flat colour (a photo, say); the image is then left whole. */
  keyed: boolean;
  /** Bounding box of everything that stayed visible. */
  box: { left: number; top: number; width: number; height: number };
}

const BORDER = 3;
/** Colour distance from the background at which a pixel is fully transparent / fully opaque. */
const EDGE = { clear: 36, solid: 96 };
/** Parts smaller than this share of the largest one are specks, not subject. */
const MIN_PART = 0.1;

/**
 * Writes the alpha channel of `rgba` in place: background and detached decoration become
 * transparent, edges get a soft matte, and edge colours are cleaned of background spill.
 */
export function cutOut(rgba: Uint8ClampedArray, width: number, height: number): Cutout {
  const count = width * height;
  const whole: Cutout = { keyed: false, box: { left: 0, top: 0, width, height } };
  const frame: number[] = [];
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    if (x < BORDER || y < BORDER || x >= width - BORDER || y >= height - BORDER) frame.push(y * width + x);
  }
  const background = [0, 1, 2].map(channel => frame.map(index => rgba[index * 4 + channel]).sort((a, b) => a - b)[frame.length >> 1]);
  const distance = (index: number) => Math.hypot(rgba[index * 4] - background[0], rgba[index * 4 + 1] - background[1], rgba[index * 4 + 2] - background[2]);
  if (frame.filter(index => distance(index) < 40).length < frame.length * 0.6) {
    for (let index = 0; index < count; index++) rgba[index * 4 + 3] = 255;
    return whole;
  }

  // Connected parts of everything that is clearly not background.
  const middle = (EDGE.clear + EDGE.solid) / 2;
  const part = new Int32Array(count);
  const sizes = [0];
  const bounds = [[0, 0, 0, 0]];
  const stack: number[] = [];
  for (let start = 0; start < count; start++) {
    if (part[start] || distance(start) <= middle) continue;
    const id = sizes.length;
    let size = 0, minX = width, minY = height, maxX = 0, maxY = 0;
    part[start] = id; stack.push(start);
    while (stack.length) {
      const index = stack.pop()!, x = index % width, y = (index - x) / width;
      size++;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const next of [index - width, index + width, x > 0 ? index - 1 : -1, x < width - 1 ? index + 1 : -1]) {
        if (next >= 0 && next < count && !part[next] && distance(next) > middle) { part[next] = id; stack.push(next); }
      }
    }
    sizes.push(size);
    bounds.push([minX, minY, maxX, maxY]);
  }
  const main = sizes.indexOf(Math.max(...sizes));
  // A part whose box surrounds the main one is a frame or ring around the subject.
  const kept = sizes.map((size, id) => id > 0 && (id === main || (size >= sizes[main] * MIN_PART
    && !(bounds[id][0] <= bounds[main][0] && bounds[id][1] <= bounds[main][1] && bounds[id][2] >= bounds[main][2] && bounds[id][3] >= bounds[main][3]))));
  const subject = (index: number) => kept[part[index]];

  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const index = y * width + x;
    // The soft edge may reach two pixels beyond the solid part it belongs to.
    let near = subject(index);
    for (let dy = -2; dy <= 2 && !near; dy++) for (let dx = -2; dx <= 2 && !near; dx++) {
      const nx = x + dx, ny = y + dy;
      near = nx >= 0 && ny >= 0 && nx < width && ny < height && subject(ny * width + nx);
    }
    const opacity = near ? Math.max(0, Math.min(1, (distance(index) - EDGE.clear) / (EDGE.solid - EDGE.clear))) : 0;
    if (opacity > 0 && opacity < 1) {
      for (let channel = 0; channel < 3; channel++) rgba[index * 4 + channel] = (rgba[index * 4 + channel] - (1 - opacity) * background[channel]) / opacity;
    }
    rgba[index * 4 + 3] = Math.round(opacity * 255);
    if (opacity < 0.1) continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
  }
  if (right < 0) {
    for (let index = 0; index < count; index++) rgba[index * 4 + 3] = 255;
    return whole;
  }
  return { keyed: true, box: { left, top, width: right - left + 1, height: bottom - top + 1 } };
}
