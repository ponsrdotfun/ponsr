/**
 * Records what a process actually opened and loaded, from inside that process.
 *
 * Preloaded with `--require` so it is installed before any application module runs. Source
 * inspection cannot answer the question this answers: a static import is easy to see, but a
 * transitive one four modules deep is not, and neither is a file opened by a dependency.
 *
 * Writes a JSON report on exit to the path in PONSR_PROBE_OUT. It never prints file contents
 * and never reads the files it observes -- only their paths.
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const opened = new Set();
const loaded = new Set();

function note(p) {
  try {
    if (typeof p === 'string' && p.length > 0) opened.add(path.resolve(p));
  } catch {
    /* a non-path argument is not interesting */
  }
}

for (const fn of ['readFileSync', 'openSync', 'existsSync', 'createReadStream', 'readFile', 'open']) {
  const original = fs[fn];
  if (typeof original !== 'function') continue;
  fs[fn] = function (p, ...rest) {
    note(p);
    return original.call(this, p, ...rest);
  };
}
if (fs.promises) {
  for (const fn of ['readFile', 'open']) {
    const original = fs.promises[fn];
    if (typeof original !== 'function') continue;
    fs.promises[fn] = function (p, ...rest) {
      note(p);
      return original.call(this, p, ...rest);
    };
  }
}

/**
 * Observes without changing the call.
 *
 * An earlier version passed an extra argument through to the original `_load` and also
 * resolved every specifier eagerly. That broke tsx's own CJS hook, which sits on top of this
 * one, with `Cannot read properties of null (reading 'shouldSkipModuleHooks')`. A probe that
 * changes the behaviour it is measuring is worse than no probe: the run it reports on is not
 * the run that would otherwise have happened.
 *
 * Arguments are forwarded verbatim, and the module name is recorded before anything else.
 */
const originalLoad = Module._load;
Module._load = function (...args) {
  if (typeof args[0] === 'string') loaded.add(args[0]);
  return originalLoad.apply(this, args);
};

function dump() {
  const out = process.env.PONSR_PROBE_OUT;
  if (!out) return;
  try {
    fs.writeFileSync(
      out,
      JSON.stringify({ opened: [...opened], loaded: [...loaded] }, null, 1),
      'utf8'
    );
  } catch {
    /* nothing useful to do while exiting */
  }
}

process.on('exit', dump);
process.on('uncaughtException', (e) => {
  dump();
  console.error('PROBE-UNCAUGHT:', e && e.message);
  process.exit(97);
});
