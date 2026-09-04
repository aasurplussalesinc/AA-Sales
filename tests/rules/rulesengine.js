'use strict';
// A CEL evaluator for Firestore security rules, driven by the authoritative
// ANTLR grammar in @firebase/eslint-plugin-security-rules.
//
// The Firestore emulator jar cannot be downloaded here (egress allowlist), so
// this stands in for it. It is deliberately strict: any grammar node it does
// not explicitly understand throws, so a rule it cannot model fails loudly
// instead of being silently reported as allowed.
const { parseForESLint } = require('@firebase/eslint-plugin-security-rules/parser');
const fs = require('fs');

class RuleError extends Error {}
const nm = (n) => (n && n.constructor ? n.constructor.name : '?');
const txt = (n) => (n && n.getText ? n.getText() : '');
const kids = (n) => (n && n.children ? n.children : []);
const named = (n) => kids(n).filter((c) => nm(c) !== 'De');
const tokens = (n) => kids(n).filter((c) => nm(c) === 'De').map(txt);

// ---------------------------------------------------------------- load
function findAll(n, name, out) {
  out = out || [];
  if (!n) return out;
  if (nm(n) === name) out.push(n);
  kids(n).forEach((c) => findAll(c, name, out));
  return out;
}

function parsePathDecl(ctx) {
  // /databases/{database}/documents  ->  [{lit:'databases'},{cap:'database'},{lit:'documents'}]
  const segs = [];
  for (const c of kids(ctx)) {
    if (nm(c) === 'SimpleSegmemntContext') {
      segs.push({ lit: txt(c).replace(/^\//, '') });
    } else if (nm(c) === 'CaptureSegmentContext') {
      const cap = findAll(c, 'CaptureContext')[0];
      const t = txt(cap).slice(1, -1); // strip { }
      if (t.endsWith('=**')) segs.push({ cap: t.slice(0, -3), multi: true });
      else segs.push({ cap: t });
    } else if (nm(c) === 'GlobSegmentContext') {
      const t = txt(c).replace(/^\//, '').slice(1, -1); // {document=**}
      segs.push({ cap: t.replace(/=\*\*$/, ''), multi: true });
    } else if (nm(c) === 'De') {
      continue;
    } else {
      throw new Error('unhandled path segment ' + nm(c) + ' in ' + txt(ctx));
    }
  }
  return segs;
}

function loadMatch(ctx) {
  // MatchRuleDeclarationContext
  const node = { path: null, fns: {}, allows: [], children: [] };
  for (const c of kids(ctx)) {
    const k = nm(c);
    if (k === 'De') continue;
    if (k === 'PathDeclContext') { node.path = parsePathDecl(c); continue; }
    if (k !== 'MatchStatementContext') throw new Error('unhandled in match: ' + k);
    for (const d of named(c)) {
      const dk = nm(d);
      if (dk === 'FunctionDeclarationContext') {
        const fname = txt(findAll(d, 'LocalFunctionIdContext')[0]);
        const sig = findAll(d, 'FunctionSignatureContext')[0];
        const plist = findAll(sig, 'ParamListContext')[0];
        const params = plist ? findAll(plist, 'LocalVariableIdContext').map(txt) : [];
        const body = findAll(d, 'ReturnStatementContext')[0];
        node.fns[fname] = { params, expr: named(body)[0] };
      } else if (dk === 'PermissionDeclarationContext') {
        const ops = txt(findAll(d, 'OperationIdContext')[0]).split(',').filter(Boolean);
        const body = findAll(d, 'PermissionBodyContext')[0];
        node.allows.push({ ops, expr: named(body)[0], src: txt(d) });
      } else if (dk === 'MatchRuleDeclarationContext') {
        node.children.push(loadMatch(d));
      } else {
        throw new Error('unhandled match statement: ' + dk);
      }
    }
  }
  return node;
}

function loadRules(file) {
  const src = fs.readFileSync(file, 'utf8');
  const r = parseForESLint(src, { filePath: file });
  const svc = findAll(r.services.tree, 'ServiceDeclarationContext')[0];
  const roots = [];
  for (const st of findAll(svc, 'ServiceStatementContext')) {
    for (const c of named(st)) {
      if (nm(c) === 'MatchRuleDeclarationContext') roots.push(loadMatch(c));
      else if (nm(c) === 'FunctionDeclarationContext') throw new Error('service-level fn unsupported');
      else throw new Error('unhandled service statement: ' + nm(c));
    }
  }
  return roots;
}

// ---------------------------------------------------------------- values
class PathVal { constructor(s) { this.p = s; } toString() { return this.p; } }
class DocVal { constructor(path, data) { this.__path = path; this.data = data; } }
class KeySet {
  constructor(a) { this.a = a.slice(); }
  hasAny(l) { return l.some((x) => this.a.indexOf(x) >= 0); }
  hasAll(l) { return l.every((x) => this.a.indexOf(x) >= 0); }
  hasOnly(l) { return this.a.every((x) => l.indexOf(x) >= 0); }
  size() { return this.a.length; }
}
class DiffVal {
  constructor(after, before) { this.after = after; this.before = before; }
  affectedKeys() {
    const keys = new Set([...Object.keys(this.after || {}), ...Object.keys(this.before || {})]);
    const out = [];
    for (const k of keys) {
      const a = (this.after || {})[k], b = (this.before || {})[k];
      if (JSON.stringify(a) !== JSON.stringify(b)) out.push(k);
    }
    return new KeySet(out);
  }
}

// ---------------------------------------------------------------- evaluator
function makeCtx(opts) {
  return {
    db: opts.db,                 // { '<full path>': {..data..} }
    accesses: [],                // every get/exists path, in order
    fns: opts.fns,               // name -> {params, expr, node}
    vars: opts.vars,
  };
}

function dbGet(ctx, path) {
  const p = String(path);
  ctx.accesses.push(p);
  return Object.prototype.hasOwnProperty.call(ctx.db, p) ? ctx.db[p] : undefined;
}

function isMap(v) { return v !== null && typeof v === 'object' && !Array.isArray(v) && !(v instanceof PathVal) && !(v instanceof DocVal) && !(v instanceof KeySet) && !(v instanceof DiffVal); }

function evalNode(n, ctx) {
  const k = nm(n);
  switch (k) {
    case 'PrimaryExpressionContext':
    case 'ParenSimpleExpressionContext':
    case 'LiteralExpressionContext':
    case 'ExpressionContext': {
      const c = named(n);
      if (c.length !== 1) throw new Error(k + ' with ' + c.length + ' children: ' + txt(n));
      return evalNode(c[0], ctx);
    }
    case 'LiteralContext': {
      const t = txt(n);
      if (t === 'true') return true;
      if (t === 'false') return false;
      if (t === 'null') return null;
      if (/^'.*'$/.test(t) || /^".*"$/.test(t)) return t.slice(1, -1);
      if (/^-?\d+$/.test(t)) return parseInt(t, 10);
      if (/^-?\d*\.\d+$/.test(t)) return parseFloat(t);
      throw new Error('unhandled literal: ' + t);
    }
    case 'LogicalOrExpressionContext': {
      const c = named(n);
      // strict left-to-right: an error anywhere denies. This is the pessimistic
      // reading; rules that pass under it pass under CEL's commutative one too.
      for (const x of c) { if (evalNode(x, ctx) === true) return true; }
      return false;
    }
    case 'LogicalAndExpressionContext': {
      for (const x of named(n)) { if (evalNode(x, ctx) !== true) return false; }
      return true;
    }
    case 'NotExpressionContext': {
      const c = named(n);
      if (c.length !== 1) throw new Error('not with ' + c.length);
      return !(evalNode(c[0], ctx) === true);
    }
    case 'EqualityExpressionContext':
    case 'RelationalExpressionContext': {
      const c = named(n);
      const ops = tokens(n);
      if (c.length !== 2 || ops.length !== 1) throw new Error(k + ' shape: ' + txt(n));
      const a = evalNode(c[0], ctx), b = evalNode(c[1], ctx);
      const eq = JSON.stringify(a === undefined ? null : a) === JSON.stringify(b === undefined ? null : b);
      switch (ops[0]) {
        case '==': return eq;
        case '!=': return !eq;
        case '<': return a < b;
        case '<=': return a <= b;
        case '>': return a > b;
        case '>=': return a >= b;
        default: throw new Error('unhandled operator ' + ops[0]);
      }
    }
    case 'AdditiveExpressionContext':
    case 'MultiplicativeExpressionContext': {
      const c = named(n), ops = tokens(n);
      if (c.length !== 2 || ops.length !== 1) throw new Error(k + ' shape: ' + txt(n));
      const a = evalNode(c[0], ctx), b = evalNode(c[1], ctx);
      if (a === undefined || b === undefined || a === null || b === null) throw new RuleError('arith on null: ' + txt(n));
      switch (ops[0]) {
        case '+': return a + b;
        case '-': return a - b;
        case '*': return a * b;
        case '/': return a / b;
        case '%': return a % b;
        default: throw new Error('unhandled operator ' + ops[0]);
      }
    }
    case 'TernaryExpressionContext': {
      const c = named(n);
      if (c.length !== 3) throw new Error('ternary shape');
      return evalNode(c[0], ctx) === true ? evalNode(c[1], ctx) : evalNode(c[2], ctx);
    }
    case 'ExprInExpressionContext': {
      const c = named(n);
      const a = evalNode(c[0], ctx), b = evalNode(c[1], ctx);
      if (Array.isArray(b)) return b.some((x) => JSON.stringify(x) === JSON.stringify(a));
      if (isMap(b)) return Object.prototype.hasOwnProperty.call(b, a);
      throw new RuleError('`in` against non-list/map: ' + txt(n));
    }
    case 'ExprIsTypeIdExpressionContext': {
      const c = named(n);
      const v = evalNode(c[0], ctx);
      const t = txt(findAll(n, 'IsOperatorIdContext')[0]);
      switch (t) {
        case 'string': return typeof v === 'string';
        case 'bool': return typeof v === 'boolean';
        case 'int': return typeof v === 'number' && Number.isInteger(v);
        case 'float': case 'number': return typeof v === 'number';
        case 'list': return Array.isArray(v);
        case 'map': return isMap(v);
        case 'path': return v instanceof PathVal;
        default: throw new Error('unhandled `is` type ' + t);
      }
    }
    case 'ListSimpleExpressionContext': {
      const el = findAll(n, 'ExpressionListContext')[0];
      if (!el) return [];
      return named(el).map((x) => evalNode(x, ctx));
    }
    case 'VariableSimpleExpressionContext': {
      const name = txt(n);
      if (!Object.prototype.hasOwnProperty.call(ctx.vars, name)) throw new RuleError('undefined variable ' + name);
      return ctx.vars[name];
    }
    case 'MemberLookupSimpleExpressionContext': {
      const c = named(n);
      if (c.length !== 2) throw new Error('member lookup shape: ' + txt(n));
      const base = evalNode(c[0], ctx);
      const field = txt(c[1]);
      if (base === null || base === undefined) throw new RuleError('field ' + field + ' of null: ' + txt(n));
      if (base instanceof DocVal) { if (field === 'data') return base.data; throw new RuleError('no field ' + field + ' on doc'); }
      if (!isMap(base)) throw new RuleError('field access on non-map: ' + txt(n));
      if (!Object.prototype.hasOwnProperty.call(base, field)) throw new RuleError('missing field ' + field + ' in ' + txt(n));
      return base[field];
    }
    case 'MemberFunctionCallSimpleExpressionContext':
    case 'IdMemberFunctionCallSimpleExpressionContext': {
      const c = named(n);
      const base = evalNode(c[0], ctx);
      const method = txt(c[1]);
      const argsCtx = c[2] && nm(c[2]) === 'ExpressionListContext' ? named(c[2]) : [];
      const args = argsCtx.map((x) => evalNode(x, ctx));
      return callMethod(base, method, args, ctx, txt(n));
    }
    case 'FunctionCallSimpleExpressionContext': {
      const fname = txt(findAll(n, 'LocalFunctionIdContext')[0]);
      const el = findAll(n, 'ExpressionListContext')[0];
      const argCtxs = el ? named(el) : [];
      if (fname === 'get' || fname === 'exists' || fname === 'existsAfter' || fname === 'getAfter') {
        const p = evalNode(argCtxs[0], ctx);
        const data = dbGet(ctx, p);
        if (fname === 'exists' || fname === 'existsAfter') return data !== undefined;
        if (data === undefined) throw new RuleError('get() on missing document ' + String(p));
        return new DocVal(String(p), data);
      }
      if (fname === 'debug') return evalNode(argCtxs[0], ctx);
      const f = ctx.fns[fname];
      if (!f) throw new Error('call to undefined function ' + fname);
      if (f.params.length !== argCtxs.length) throw new Error('arity mismatch calling ' + fname);
      const args = argCtxs.map((x) => evalNode(x, ctx));
      const sub = { db: ctx.db, accesses: ctx.accesses, fns: ctx.fns, vars: Object.assign({}, ctx.vars) };
      f.params.forEach((p, i) => { sub.vars[p] = args[i]; });
      return evalNode(f.expr, sub);
    }
    case 'PathSimpleExpressionContext': {
      const pe = findAll(n, 'PathExpressionContext')[0];
      let out = '';
      for (const seg of kids(pe)) {
        if (nm(seg) !== 'PathExpressionSegmentContext') throw new Error('unhandled path child ' + nm(seg));
        const inner = named(seg);
        if (inner.length === 1 && nm(inner[0]) === 'SimpleSegmemntContext') { out += txt(inner[0]); continue; }
        if (inner.length === 1) { out += '/' + String(evalNode(inner[0], ctx)); continue; }
        throw new Error('unhandled path segment: ' + txt(seg));
      }
      return new PathVal(out);
    }
    default:
      throw new Error('UNHANDLED NODE TYPE ' + k + '  ::  ' + txt(n));
  }
}

function callMethod(base, method, args, ctx, src) {
  if (base instanceof DiffVal && method === 'affectedKeys') return base.affectedKeys();
  if (base instanceof KeySet) {
    if (method === 'hasAny') return base.hasAny(args[0]);
    if (method === 'hasAll') return base.hasAll(args[0]);
    if (method === 'hasOnly') return base.hasOnly(args[0]);
    if (method === 'size') return base.size();
  }
  if (isMap(base)) {
    if (method === 'get') {
      if (args.length !== 2) throw new Error('map.get needs (key, default)');
      return Object.prototype.hasOwnProperty.call(base, args[0]) ? base[args[0]] : args[1];
    }
    if (method === 'keys') return Object.keys(base);
    if (method === 'values') return Object.values(base);
    if (method === 'size') return Object.keys(base).length;
    if (method === 'diff') return new DiffVal(base, args[0]);
  }
  if (Array.isArray(base)) {
    if (method === 'hasAny') return new KeySet(base).hasAny(args[0]);
    if (method === 'hasAll') return new KeySet(base).hasAll(args[0]);
    if (method === 'hasOnly') return new KeySet(base).hasOnly(args[0]);
    if (method === 'size') return base.length;
  }
  if (typeof base === 'string') {
    if (method === 'size') return base.length;
    if (method === 'lower') return base.toLowerCase();
    if (method === 'upper') return base.toUpperCase();
    if (method === 'matches') return new RegExp('^(?:' + args[0] + ')$').test(base);
    if (method === 'split') return base.split(new RegExp(args[0]));
  }
  if (base === null || base === undefined) throw new RuleError('method ' + method + ' on null: ' + src);
  throw new Error('unhandled method ' + method + ' on ' + (base && base.constructor ? base.constructor.name : typeof base) + ' :: ' + src);
}

// ---------------------------------------------------------------- matching
const COVER = { get: ['get', 'read'], list: ['list', 'read'], create: ['create', 'write'], update: ['update', 'write'], delete: ['delete', 'write'] };

function collect(node, segs, vars, out) {
  const pat = node.path;
  let i = 0, v = Object.assign({}, vars);
  for (const s of pat) {
    if (s.multi) { v[s.cap] = segs.slice(i).join('/'); i = segs.length; break; }
    if (i >= segs.length) return;
    if (s.lit !== undefined) { if (segs[i] !== s.lit) return; }
    else v[s.cap] = segs[i];
    i++;
  }
  const rest = segs.slice(i);
  const lastMulti = pat.length && pat[pat.length - 1].multi;
  if (rest.length === 0 || lastMulti) {
    for (const a of node.allows) out.push({ allow: a, vars: v });
  }
  for (const ch of node.children) collect(ch, rest, v, out);
}

function evaluate(roots, req) {
  // req: { path, op, auth, resource, request_resource, db }
  const segs = req.path.replace(/^\//, '').split('/');
  const cands = [];
  for (const r of roots) collect(r, segs, {}, cands);
  const wanted = COVER[req.op];
  if (!wanted) throw new Error('unknown op ' + req.op);
  const trace = [];
  let allowed = false;
  const accesses = [];
  for (const c of cands) {
    if (!c.allow.ops.some((o) => wanted.indexOf(o) >= 0)) continue;
    // find the owning match node's function table: functions are lexically
    // scoped, but this ruleset declares them all in the one outer block, so
    // gather every function from every node.
    const fns = {};
    (function gather(list) { for (const n of list) { Object.assign(fns, n.fns); gather(n.children); } })(roots);
    const ctx = makeCtx({
      db: req.db,
      fns,
      vars: Object.assign({}, c.vars, {
        request: {
          auth: req.auth === undefined ? null : req.auth,
          resource: req.request_resource === undefined ? null : { data: req.request_resource },
          time: req.time || 0,
          method: req.op,
        },
        resource: req.resource === undefined ? null : { data: req.resource },
      }),
    });
    let res, err = null;
    try { res = evalNode(c.allow.expr, ctx); }
    catch (e) { if (e instanceof RuleError) { res = false; err = e.message; } else throw e; }
    accesses.push(...ctx.accesses);
    trace.push({ rule: c.allow.src.split('\n')[0].trim(), result: res === true, error: err, accesses: ctx.accesses.length });
    if (res === true) allowed = true;
  }
  const distinct = new Set(accesses);
  return { allowed, trace, accessCalls: accesses.length, distinctAccessCalls: distinct.size, accesses };
}

module.exports = { loadRules, evaluate, RuleError };
