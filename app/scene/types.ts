// Types shared by the Node pipeline and the browser scene.
import type { IconName } from '../icons.js';
import type { Profile } from '../model.js';

export const COLOR_TOKENS = ['bg', 'bgDark', 'bgDarker', 'bgLight', 'selection', 'muted', 'fg', 'fgBright', 'accent', 'red', 'yellow', 'orange', 'green', 'cyan', 'blue', 'magenta'] as const;
export type ColorToken = typeof COLOR_TOKENS[number];
export interface Theme { key: string; name: string; colors: Record<ColorToken, string> }

export const ACCENTS = ['blue', 'magenta', 'green', 'cyan', 'yellow', 'orange', 'red'] as const;
export type Accent = typeof ACCENTS[number];
export const PORTRAIT_STYLES = ['halftone', 'glyphs', 'led', 'disco'] as const;
export type PortraitStyle = typeof PORTRAIT_STYLES[number];

export interface Row { icon: IconName; label: string; value: string }
export interface Section { color: Accent; rows: Row[] }
export interface CardConfig {
  /** Shown after the @ in the title line. */
  host: string;
  /** IANA zone for the bar clock, which shows when the statistics were collected. */
  timezone: string;
  /** A theme key from themes/, or "cycle" to step through `cycle`. */
  theme: string;
  cycle: string[];
  /** How the avatar is drawn: one of PORTRAIT_STYLES, or "cycle" to change style with every look. */
  portrait: PortraitStyle | 'cycle';
  sections: Section[];
}

/** `themes` and `portraits` are stepped through together; a single entry means it stays fixed. */
export interface SceneInput { profile: Profile; config: CardConfig; themes: Theme[]; portraits: PortraitStyle[]; preview: boolean }

/** Everything that can differ between two frames. The scene is a pure function of this. */
export interface State {
  theme: string;
  portrait: PortraitStyle;
  /** Theme-change notification, shown while cycling. */
  toast: boolean;
  /** Number of tiled windows currently open. */
  open: 0 | 1 | 2 | 3;
  focus: 0 | 1 | 2;
  cursor: boolean;
  /** Idle animation step of the portrait: 0 at rest, counting up through the holds. */
  tick: number;
  /** Per window: characters typed of each command, and 0-1 progress of its output. */
  fetch: { typed: number; output: number };
  stats: { typed: number; output: number };
  top: { typed: number; output: number };
  heat: { typed: number; output: number };
}
export interface Frame { delay: number; state: State }
