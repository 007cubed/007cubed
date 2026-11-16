declare module 'gifenc' {
  export function quantize(data: Uint8Array, colors: number, options?: { format?: 'rgb565' | 'rgb444' | 'rgba4444' }): number[][];
  export interface FrameOptions { palette?: number[][]; delay?: number; repeat?: number; transparent?: boolean; transparentIndex?: number; dispose?: number }
  export function GIFEncoder(): {
    writeFrame(index: Uint8Array, width: number, height: number, options: FrameOptions): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
  };
  const api: { GIFEncoder: typeof GIFEncoder; quantize: typeof quantize };
  export default api;
}
