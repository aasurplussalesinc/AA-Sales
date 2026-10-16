// Box presets (Alan 2026-10-16): each tenant names its own box sizes in Settings, and the packing screen shows
// them as one-click buttons that fill a box's L × W × H. An org that has never saved any keeps the two original
// buttons (24×16×17 and 24×16×24); saving an empty list means no buttons.

export const MAX_BOX_PRESETS = 12;
export const MAX_DIMENSION_IN = 120;

export const DEFAULT_BOX_PRESETS = Object.freeze([
  Object.freeze({ id: 'default-17', name: '17"', length: 24, width: 16, height: 17 }),
  Object.freeze({ id: 'default-24', name: '24"', length: 24, width: 16, height: 24 }),
]);

export function boxPresetsFor(organization) {
  return Array.isArray(organization?.boxPresets) ? organization.boxPresets : DEFAULT_BOX_PRESETS;
}

/** A preset as typed in Settings -> the stored form, or null with a reason when it can't be saved. */
export function cleanBoxPreset(raw) {
  const name = String(raw?.name ?? '').trim().slice(0, 24);
  const dims = ['length', 'width', 'height'].map(k => Number(raw?.[k]));
  if (!name) return { preset: null, error: 'Give the box a name.' };
  if (dims.some(n => !Number.isFinite(n) || n <= 0 || n > MAX_DIMENSION_IN)) {
    return { preset: null, error: `Length, width and height must be between 0 and ${MAX_DIMENSION_IN} inches.` };
  }
  const [length, width, height] = dims.map(n => Math.round(n * 2) / 2);   // half-inch steps, like the packing inputs
  const id = String(raw?.id || `box-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`);
  return { preset: { id, name, length, width, height }, error: null };
}

export const presetLabel = p => `${p.length}×${p.width}×${p.height}`;

/** True when a box's typed dimensions are exactly this preset (to highlight the button that's in use). */
export function matchesPreset(details, p) {
  return !!details && ['length', 'width', 'height'].every(k => Number(details[k]) === Number(p[k]));
}
