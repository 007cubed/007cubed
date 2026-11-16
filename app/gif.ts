// Animated GIF writer that stores only what changed between frames.
import { createRequire } from 'node:module';
const { GIFEncoder, quantize } = createRequire(import.meta.url)('gifenc') as typeof import('gifenc').default;

export type Palette = number[][];
const TRANSPARENT = 255;

/** Up to 255 colours picked from RGBA samples; the last slot is kept free for transparency. */
export function buildPalette(samples: Uint8Array): Palette {
  const palette = quantize(samples, TRANSPARENT, { format: 'rgb565' });
  while (palette.length < 256) palette.push([0, 0, 0]);
  return palette;
}

interface Pending { index: Uint8Array; x: number; y: number; width: number; height: number; delay: number; palette: Palette; full: boolean }

/**
 * Frames that share a palette are written as the bounding box of their changed pixels,
 * with unchanged pixels inside the box left transparent. A new palette starts a full frame.
 * Frames without any change only extend the previous frame's delay.
 */
export class DeltaGif {
  private readonly gif = GIFEncoder();
  private readonly lookups = new Map<Palette, Int16Array>();
  private previous?: Uint32Array;
  private pending?: Pending;
  private global?: Palette;

  constructor(private readonly width: number, private readonly height: number) {}

  add(rgba: Uint8Array, delay: number, palette: Palette): void {
    if (rgba.length !== this.width * this.height * 4) throw new Error('Frame size does not match the GIF');
    const pixels = new Uint32Array(new Uint8Array(rgba).buffer);
    const previous = this.pending?.palette === palette ? this.previous : undefined;
    let left = 0, top = 0, right = this.width - 1, bottom = this.height - 1;
    if (previous) {
      left = this.width; top = this.height; right = -1; bottom = -1;
      for (let y = 0, offset = 0; y < this.height; y++) for (let x = 0; x < this.width; x++, offset++) {
        if (pixels[offset] === previous[offset]) continue;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        bottom = y;
      }
      if (right < 0) { this.pending!.delay += delay; return; }
    }
    const width = right - left + 1, height = bottom - top + 1;
    const index = new Uint8Array(width * height);
    const lookup = this.lookup(palette);
    for (let y = 0, target = 0; y < height; y++) for (let x = 0, offset = (top + y) * this.width + left; x < width; x++, offset++, target++) {
      const pixel = pixels[offset];
      if (previous && pixel === previous[offset]) { index[target] = TRANSPARENT; continue; }
      const red = pixel & 255, green = (pixel >>> 8) & 255, blue = (pixel >>> 16) & 255;
      const key = ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3);
      if (lookup[key] < 0) {
        let nearest = 0, distance = Infinity;
        for (let color = 0; color < TRANSPARENT; color++) {
          const score = (red - palette[color][0]) ** 2 + (green - palette[color][1]) ** 2 + (blue - palette[color][2]) ** 2;
          if (score < distance) { distance = score; nearest = color; }
        }
        lookup[key] = nearest;
      }
      index[target] = lookup[key];
    }
    this.flush();
    this.pending = { index, x: left, y: top, width, height, delay, palette, full: !previous };
    this.previous = pixels;
  }

  finish(): Uint8Array {
    this.flush();
    this.gif.finish();
    return this.gif.bytes();
  }

  private lookup(palette: Palette): Int16Array {
    let lookup = this.lookups.get(palette);
    if (!lookup) this.lookups.set(palette, lookup = new Int16Array(65536).fill(-1));
    return lookup;
  }

  private flush(): void {
    const frame = this.pending;
    if (!frame) return;
    this.pending = undefined;
    if (!this.global) {
      this.global = frame.palette;
      this.gif.writeFrame(frame.index, frame.width, frame.height, { palette: frame.palette, delay: frame.delay, repeat: 0, dispose: 1 });
      return;
    }
    const start = this.gif.bytesView().length;
    this.gif.writeFrame(frame.index, frame.width, frame.height, {
      palette: frame.palette === this.global ? undefined : frame.palette,
      delay: frame.delay, dispose: 1, transparent: !frame.full, transparentIndex: TRANSPARENT,
    });
    // gifenc always writes frames at 0,0. The image descriptor follows the 8-byte
    // graphic control extension; move the frame to its rectangle there.
    const bytes = this.gif.bytesView();
    if (bytes[start] !== 0x21 || bytes[start + 1] !== 0xf9 || bytes[start + 8] !== 0x2c) throw new Error('Unexpected GIF frame layout');
    bytes[start + 9] = frame.x & 255; bytes[start + 10] = frame.x >> 8;
    bytes[start + 11] = frame.y & 255; bytes[start + 12] = frame.y >> 8;
  }
}
