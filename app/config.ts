// config.json: the hand-written half of the card (info rows, host name, theme choice).
import { readFile } from 'node:fs/promises';
import { ICONS, type IconName } from './icons.js';
import { ACCENTS, PORTRAIT_STYLES, type Accent, type CardConfig, type PortraitStyle } from './scene/types.js';

function fail(message: string): never { throw new Error(`Invalid config: ${message}`); }
function text(value: unknown, field: string, pattern = /^.{1,60}$/u): string {
  return typeof value === 'string' && pattern.test(value) ? value : fail(field);
}

function portraitStyle(value: unknown): PortraitStyle {
  return PORTRAIT_STYLES.includes(value as PortraitStyle) ? value as PortraitStyle : fail(`portrait (use ${PORTRAIT_STYLES.join(', ')} or cycle)`);
}

export function validateConfig(value: unknown): CardConfig {
  const data = (value && typeof value === 'object' ? value : fail('not an object')) as Record<string, unknown>;
  const themeName = /^[a-z0-9-]+$/;
  const timezone = text(data.timezone, 'timezone');
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }); } catch { fail('timezone'); }
  const cycle = Array.isArray(data.cycle) && data.cycle.length ? data.cycle.map(key => text(key, 'cycle', themeName)) : fail('cycle');
  const sections = Array.isArray(data.sections) && data.sections.length ? data.sections : fail('sections');
  return {
    host: text(data.host, 'host', /^[a-z0-9-]{1,24}$/),
    timezone,
    theme: text(data.theme, 'theme', themeName),
    cycle,
    portrait: data.portrait === 'cycle' ? 'cycle' : portraitStyle(data.portrait),
    sections: sections.map(entry => {
      const section = (entry && typeof entry === 'object' ? entry : fail('sections')) as Record<string, unknown>;
      const rows = Array.isArray(section.rows) && section.rows.length ? section.rows : fail('sections.rows');
      return {
        color: ACCENTS.includes(section.color as Accent) ? section.color as Accent : fail(`sections.color (use one of ${ACCENTS.join(', ')})`),
        rows: rows.map(item => {
          const row = (item && typeof item === 'object' ? item : fail('row')) as Record<string, unknown>;
          return {
            icon: typeof row.icon === 'string' && row.icon in ICONS ? row.icon as IconName : fail(`row icon "${String(row.icon)}" (see app/icons.ts)`),
            label: text(row.label, 'row label'),
            value: text(row.value, 'row value'),
          };
        }),
      };
    }),
  };
}

export async function loadConfig(file = 'config.json'): Promise<CardConfig> {
  return validateConfig(JSON.parse(await readFile(file, 'utf8')));
}

/** The themes a render steps through: one, or the configured cycle. `choice` overrides config.theme. */
export function themeKeys(config: CardConfig, choice = config.theme): string[] {
  return choice === 'cycle' ? config.cycle : [choice];
}

/** The portrait styles a render steps through, in step with the themes. `choice` overrides config.portrait. */
export function portraitStyles(config: CardConfig, choice: string = config.portrait): PortraitStyle[] {
  return choice === 'cycle' ? [...PORTRAIT_STYLES] : [portraitStyle(choice)];
}
