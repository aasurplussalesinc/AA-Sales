// AA Surplus Sales' default notes for its AI assistant, shown in Settings -> API Access until AA saves its own.
// Must stay identical to AA_DEFAULT_NOTES in functions/apiAccess.js (tests/unit/apiAccess.test.mjs checks).
export const AA_DEFAULT_AI_NOTES = [
  'AA Surplus Sales Inc. is a military surplus wholesaler.',
  '',
  'GRADE is the most important field after SKU. The same product exists in several',
  'conditions and they are different products at different prices: NEW (unissued),',
  '#1 (good used), #2 (lower grade used). Never merge grades in a count or a',
  'recommendation. "How many assault pouches" almost always means "how many of each',
  'grade". Note that the grade field is frequently blank with the grade written into',
  'the item name instead - say so rather than silently guessing.',
  '',
  'LOCATION CODES look like W4-R1-F2: W4 warehouse, R1 rack, F bay/column, 2 shelf.',
  '',
  'Surplus moves in irregular lots - a quantity that looks odd usually is odd, not a typo.'
].join('\n');

export const MAX_AI_NOTES = 4000;
