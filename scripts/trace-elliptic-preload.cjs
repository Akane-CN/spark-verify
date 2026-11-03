// Reachability probe for the elliptic waiver (docs/waiver-renewal-fallback.md). Loaded into every
// Bun and Node process of a run; appends one line per elliptic EC/key method call to
// $ELLIPTIC_TRACE. $ELLIPTIC_ROOT is the checkout whose node_modules to instrument. Never throws.
const fs = require("node:fs");
const pathMod = require("node:path");
const log = process.env.ELLIPTIC_TRACE;
try {
  const root = process.env.ELLIPTIC_ROOT;
  const p = require.resolve("elliptic", { paths: [root + "/node_modules/@nervosnetwork/ckb-sdk-utils"] });
  const elliptic = require(p);
  const rt = typeof Bun !== "undefined" ? "bun" : "node";
  fs.appendFileSync(log, `load ${rt} pid=${process.pid} main=${process.argv[1] ?? ""}\n`);
  const wrap = (proto, name, label) => { const orig = proto[name]; if (typeof orig !== "function") return;
    proto[name] = function (...a) { fs.appendFileSync(log, `CALL ${label}.${name} ${rt} pid=${process.pid} main=${process.argv[1] ?? ""}\n`); return orig.apply(this, a); }; };
  for (const m of ["keyFromPrivate","keyFromPublic","genKeyPair","sign","verify","recoverPubKey"]) wrap(elliptic.ec.prototype, m, "ec");
  const KeyPair = require(pathMod.join(pathMod.dirname(p), "elliptic/ec/key.js"));
  for (const m of ["sign","verify","getPublic","derive"]) wrap(KeyPair.prototype, m, "key");
} catch (e) { fs.appendFileSync(log, `preload-error pid=${process.pid}: ${e && e.message}\n`); }
