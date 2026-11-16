// Pure aggregation: turns raw counts into the coarse figures that may be published.
import { HEATMAP_WEEKS, MAX_LANGUAGES, WEEKS, type Activity, type LanguageShare } from './model.js';

/** Formats cloc reports as languages that are data or prose, not code. GitHub's language bar skips them too. */
const NOT_CODE = new Set(['JSON', 'JSON5', 'YAML', 'TOML', 'XML', 'SVG', 'CSV', 'INI', 'Properties', 'Markdown', 'Text', 'reStructuredText', 'AsciiDoc', 'diff']);

/** Shorter labels for cloc's longer language names. */
const ALIASES: Record<string, string> = { 'Bourne Shell': 'Shell', 'Bourne Again Shell': 'Shell', 'Vuejs Component': 'Vue', 'Jupyter Notebook': 'Jupyter', 'C/C++ Header': 'C/C++', 'DOS Batch': 'Batch' };
export const MAX_LANGUAGE_NAME = 12;

/** Top languages by lines of code as whole percentages that sum to 100, the rest folded into "other". */
export function languageShare(lines: Record<string, number>): LanguageShare[] {
  const labelled: Record<string, number> = {};
  for (const [name, value] of Object.entries(lines)) {
    if (NOT_CODE.has(name) || !(value > 0)) continue;
    // Labels are cut to what the card can show and to the characters the allowlist accepts.
    const label = (ALIASES[name] ?? name).replace(/[^A-Za-z0-9 #+.'/-]/g, '').replace(/^[^A-Za-z0-9]+/, '').slice(0, MAX_LANGUAGE_NAME).trim() || 'other';
    labelled[label] = (labelled[label] ?? 0) + value;
  }
  const ranked = Object.entries(labelled).filter(([name]) => name !== 'other').sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const total = Object.values(labelled).reduce((sum, value) => sum + value, 0);
  if (!total) return [];
  const top = ranked.slice(0, MAX_LANGUAGES - 1);
  const rest = total - top.reduce((sum, [, value]) => sum + value, 0);
  const entries = rest ? [...top, ['other', rest] as [string, number]] : top;
  // Largest-remainder rounding keeps the published percentages adding up to exactly 100.
  const exact = entries.map(([name, value]) => ({ name, percent: Math.floor(value * 100 / total), remainder: value * 100 % total }));
  let missing = 100 - exact.reduce((sum, entry) => sum + entry.percent, 0);
  for (const entry of [...exact].sort((a, b) => b.remainder - a.remainder)) if (missing-- > 0) entry.percent++;
  return exact.filter(entry => entry.percent > 0).map(({ name, percent }) => ({ name, percent }));
}

/** Days needed before `end` to fill 52 Monday-based weeks. */
export const ACTIVITY_DAYS = WEEKS * 7;

/**
 * Reduces daily counts (oldest first, the last entry being the `end` date, YYYY-MM-DD)
 * to weekly totals, 0-4 intensity levels and streaks.
 */
export function summarizeActivity(daily: number[], end: string, source: Activity['source']): Activity {
  const weekday = (new Date(`${end}T00:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  if (Number.isNaN(weekday)) throw new Error('Invalid activity end date');
  const span = (WEEKS - 1) * 7 + weekday + 1;
  const days = [...new Array<number>(Math.max(0, span - daily.length)).fill(0), ...daily.slice(-span)];
  const weeks = Array.from({ length: WEEKS }, (_, week) => days.slice(week * 7, week * 7 + 7).reduce((sum, value) => sum + value, 0));
  const recent = days.slice((WEEKS - HEATMAP_WEEKS) * 7);
  const active = recent.filter(value => value > 0).sort((a, b) => a - b);
  const quartiles = [0.25, 0.5, 0.75].map(share => active[Math.floor(share * active.length)] ?? 0);
  const levels = recent.map(value => (value ? 1 + quartiles.filter(threshold => value > threshold).length : 0));
  let longestStreak = 0, run = 0;
  for (const value of days) { run = value ? run + 1 : 0; longestStreak = Math.max(longestStreak, run); }
  // A day that has not seen activity yet does not break the current streak.
  let streak = 0;
  for (let index = days.length - (days.at(-1) ? 1 : 2); index >= 0 && days[index]; index--) streak++;
  return { source, total: days.reduce((sum, value) => sum + value, 0), streak, longestStreak, weeks, levels };
}
