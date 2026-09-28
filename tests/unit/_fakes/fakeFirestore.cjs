'use strict';
// A small in-memory stand-in for the parts of the Admin SDK Firestore API that
// the invoicing and billing modules use. It lives in a sub-folder so the
// `node --test tests/unit/*.mjs` glob never mistakes it for a test file.
//
// Supported: collection().doc().get/set(merge)/update(dotted paths)/delete,
// collection().add, where(==, in, array-contains, >, <, >=, <=, !=), limit,
// orderBy (single field), runTransaction (get/set/update on docs and queries).
// Writes are recorded in `db.writes` so a test can assert exactly what changed.

function clone(v) { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); }
function isPlainObject(v) { return v && typeof v === 'object' && !Array.isArray(v); }

function getPath(obj, path) {
  return String(path).split('.').reduce(function (o, k) { return o == null ? undefined : o[k]; }, obj);
}
function setPath(obj, path, value) {
  var parts = String(path).split('.');
  var o = obj;
  for (var i = 0; i < parts.length - 1; i++) {
    if (!isPlainObject(o[parts[i]])) o[parts[i]] = {};
    o = o[parts[i]];
  }
  if (value && value.__delete) delete o[parts[parts.length - 1]];
  else o[parts[parts.length - 1]] = value;
}
function deepMerge(target, src) {
  Object.keys(src).forEach(function (k) {
    var v = src[k];
    if (v && v.__delete) { delete target[k]; return; }
    if (isPlainObject(v) && !v.__sentinel && isPlainObject(target[k])) deepMerge(target[k], v);
    else target[k] = clone(v);
  });
  return target;
}

var autoId = 0;

function createFakeDb(seed) {
  var store = {};           // 'col/id' -> data
  var writes = [];
  Object.keys(seed || {}).forEach(function (k) { store[k] = clone(seed[k]); });

  function snap(path, id) {
    var data = store[path];
    return {
      id: id, exists: data !== undefined, ref: docRef(path),
      data: function () { return data === undefined ? undefined : clone(data); },
      get: function (f) { return getPath(data || {}, f); }
    };
  }

  function docRef(path) {
    var parts = path.split('/');
    var id = parts[parts.length - 1];
    var ref = {
      id: id, path: path,
      get: async function () { return snap(path, id); },
      set: async function (data, opts) { applySet(path, data, opts); },
      update: async function (data) { applyUpdate(path, data); },
      delete: async function () { writes.push({ op: 'delete', path: path }); delete store[path]; },
      collection: function (sub) { return collectionRef(path + '/' + sub); }
    };
    return ref;
  }

  function applySet(path, data, opts) {
    writes.push({ op: 'set', path: path, data: clone(data), merge: !!(opts && opts.merge) });
    if (opts && opts.merge && store[path]) deepMerge(store[path], data);
    else store[path] = deepMerge({}, data);
  }
  function applyUpdate(path, data) {
    if (store[path] === undefined) {
      var e = new Error('NOT_FOUND: no document to update: ' + path); e.code = 5; throw e;
    }
    writes.push({ op: 'update', path: path, data: clone(data) });
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      setPath(store[path], k, (v && v.__sentinel) ? v : clone(v));
    });
  }

  function matches(data, f) {
    var v = getPath(data, f.field);
    switch (f.op) {
      case '==': return JSON.stringify(v) === JSON.stringify(f.value);
      case '!=': return v !== undefined && JSON.stringify(v) !== JSON.stringify(f.value);
      case 'in': return f.value.some(function (x) { return JSON.stringify(x) === JSON.stringify(v); });
      case 'array-contains': return Array.isArray(v) && v.some(function (x) { return JSON.stringify(x) === JSON.stringify(f.value); });
      case '>': return v !== undefined && v > f.value;
      case '>=': return v !== undefined && v >= f.value;
      case '<': return v !== undefined && v < f.value;
      case '<=': return v !== undefined && v <= f.value;
      default: throw new Error('fake firestore: unsupported op ' + f.op);
    }
  }

  function query(col, filters, lim, order) {
    var q = {
      where: function (field, op, value) { return query(col, filters.concat([{ field: field, op: op, value: value }]), lim, order); },
      limit: function (n) { return query(col, filters, n, order); },
      orderBy: function (field, dir) { return query(col, filters, lim, { field: field, dir: dir || 'asc' }); },
      get: async function () {
        var prefix = col + '/';
        var docs = Object.keys(store).filter(function (p) {
          return p.indexOf(prefix) === 0 && p.slice(prefix.length).indexOf('/') === -1;
        }).filter(function (p) {
          return filters.every(function (f) { return matches(store[p], f); });
        }).map(function (p) { return snap(p, p.slice(prefix.length)); });
        if (order) {
          docs.sort(function (a, b) {
            var x = getPath(a.data(), order.field), y = getPath(b.data(), order.field);
            var c = x < y ? -1 : x > y ? 1 : 0;
            return order.dir === 'desc' ? -c : c;
          });
        }
        if (lim) docs = docs.slice(0, lim);
        return { docs: docs, empty: docs.length === 0, size: docs.length,
                 forEach: function (fn) { docs.forEach(fn); } };
      }
    };
    return q;
  }

  function collectionRef(name) {
    var base = query(name, [], null, null);
    base.doc = function (id) { return docRef(name + '/' + (id || ('auto' + (++autoId)))); };
    base.add = async function (data) {
      var ref = base.doc();
      applySet(ref.path, data);
      return ref;
    };
    return base;
  }

  var db = {
    store: store,
    writes: writes,
    collection: collectionRef,
    doc: function (path) { return docRef(path); },
    getAll: async function () {
      var refs = Array.prototype.slice.call(arguments);
      return Promise.all(refs.map(function (r) { return r.get(); }));
    },
    runTransaction: async function (fn) {
      var tx = {
        get: async function (refOrQuery) { return refOrQuery.get(); },
        set: function (ref, data, opts) { applySet(ref.path, data, opts); return tx; },
        update: function (ref, data) { applyUpdate(ref.path, data); return tx; },
        create: function (ref, data) {
          if (store[ref.path] !== undefined) { var e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; }
          applySet(ref.path, data); return tx;
        },
        delete: function (ref) { writes.push({ op: 'delete', path: ref.path }); delete store[ref.path]; return tx; }
      };
      return fn(tx);
    },
    batch: function () {
      var ops = [];
      return {
        set: function (ref, data, opts) { ops.push(function () { applySet(ref.path, data, opts); }); },
        update: function (ref, data) { ops.push(function () { applyUpdate(ref.path, data); }); },
        commit: async function () { ops.forEach(function (f) { f(); }); }
      };
    },
    data: function (path) { return clone(store[path]); }
  };
  return db;
}

// Mimics admin.firestore.FieldValue for the handful of sentinels in use.
var FieldValue = {
  serverTimestamp: function () { return { __sentinel: 'serverTimestamp' }; },
  delete: function () { return { __sentinel: 'delete', __delete: true }; }
};

module.exports = { createFakeDb: createFakeDb, FieldValue: FieldValue };
