// Box presets (Alan 2026-10-16): tenant-named box sizes, one click on the packing screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boxPresetsFor, cleanBoxPreset, matchesPreset, presetLabel, DEFAULT_BOX_PRESETS } from '../../src/boxPresets.js';

test('an org that never saved presets keeps the two original buttons', () => {
  assert.deepEqual(boxPresetsFor({}).map(presetLabel), ['24×16×17', '24×16×24']);
  assert.equal(boxPresetsFor(null), DEFAULT_BOX_PRESETS);
});

test('a saved list wins, and an empty list means no buttons', () => {
  const mine = [{ id: 'a', name: 'Small', length: 12, width: 10, height: 8 }];
  assert.deepEqual(boxPresetsFor({ boxPresets: mine }), mine);
  assert.deepEqual(boxPresetsFor({ boxPresets: [] }), []);
});

test('cleaning: name trimmed, numbers to half inches, id kept or made', () => {
  const { preset, error } = cleanBoxPreset({ id: 'x1', name: '  Medium  ', length: '18', width: '18.3', height: 12 });
  assert.equal(error, null);
  assert.deepEqual(preset, { id: 'x1', name: 'Medium', length: 18, width: 18.5, height: 12 });
  assert.match(cleanBoxPreset({ name: 'A', length: 1, width: 1, height: 1 }).preset.id, /^box-/);
});

test('bad presets are refused with a reason', () => {
  assert.ok(cleanBoxPreset({ name: '', length: 1, width: 1, height: 1 }).error);
  assert.ok(cleanBoxPreset({ name: 'A', length: 0, width: 1, height: 1 }).error);
  assert.ok(cleanBoxPreset({ name: 'A', length: 'x', width: 1, height: 1 }).error);
  assert.ok(cleanBoxPreset({ name: 'A', length: 500, width: 1, height: 1 }).error);
});

test('the button in use lights up only on an exact match', () => {
  const p = { length: 24, width: 16, height: 17 };
  assert.equal(matchesPreset({ length: '24', width: '16', height: '17', weight: '30' }, p), true);
  assert.equal(matchesPreset({ length: '24', width: '16', height: '24' }, p), false);
  assert.equal(matchesPreset(undefined, p), false);
});
