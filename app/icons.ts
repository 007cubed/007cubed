// Nerd Font code points available to config rows and the scene.
export const ICONS = {
  arch: 0xf303, window: 0xf2d0, brush: 0xf1fc, terminal: 0xf120, laptop: 0xf109, chip: 0xf4bc,
  study: 0xf19d, shield: 0xf132, pin: 0xf041, heart: 0xf004, globe: 0xf0ac, edit: 0xf044,
  cloud: 0xf0c2, gear: 0xf013, bolt: 0xf0e7, code: 0xf121, commit: 0xf417, repo: 0xf401,
  star: 0xf005, clock: 0xf017, flame: 0xf06d, bluetooth: 0xf293, wifi: 0xf1eb, volume: 0xf028,
  battery: 0xf240, chevron: 0xf054, camera: 0xf030, chart: 0xf201, lock: 0xf023, user: 0xf007,
} as const;
export type IconName = keyof typeof ICONS;
export const icon = (name: IconName): string => String.fromCodePoint(ICONS[name]);
