const { parseForESLint } = require('@firebase/eslint-plugin-security-rules/parser');
const fs = require('fs');
const file = process.argv[2] || require('path').join(__dirname, '..', '..', 'firestore.rules');
const src = fs.readFileSync(file, 'utf8');
try {
  const r = parseForESLint(src, { filePath: file });
  const errs = (r.services && r.services.errors) || r.errors || [];
  console.log('parsed OK. keys=', Object.keys(r).join(','), 'servicesKeys=', r.services?Object.keys(r.services).join(','):'-');
  if (errs.length) { console.log('ERRORS:', JSON.stringify(errs,null,1)); process.exit(1); }
} catch (e) {
  console.log('PARSE FAILED:', e.message);
  process.exit(1);
}
