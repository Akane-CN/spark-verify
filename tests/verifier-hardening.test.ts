// Regressions for the 2026-11-02 pre-release review of the v0.1.0 candidate: artifacts no runner can write
// must not verify, and malformed bundles must be INVALID rather than crash.
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findDuplicateKey, parseJsonStrict } from "../src/json-strict";
import { inspectReportFile } from "../src/offline";
import { assertRejectionEvidence, errorCodeSatisfied } from "../src/rejection";
import { packageEvidence, verifyBundle } from "../src/evidence-bundle";
import { scriptHash } from "../src/transaction";
import { syntheticReportV2 } from "./fixtures/claims-v2/synthetic";
import { syntheticReportV3 } from "./fixtures/claims-v3/synthetic";

const directories: string[] = [];
const temp = async (prefix: string) => { const d = await mkdtemp(join(tmpdir(), prefix)); directories.push(d); return d; };

describe("strict JSON", () => {
  test("finds a repeated key at any depth and ignores repeated values or keys in different objects", () => {
    expect(findDuplicateKey('{"a":1,"b":{"a":2}}')).toBeUndefined();
    expect(findDuplicateKey('{"a":"a","b":["a","a"]}')).toBeUndefined();
    expect(findDuplicateKey('{"verdict":"FAIL","x":1,"verdict":"PASS"}')).toBe("verdict");
    expect(findDuplicateKey('{"o":{"k":1,"k\\u0000":2,"k":3}}')).toBe("k");
    expect(findDuplicateKey('[{"a":1},{"a":2}]')).toBeUndefined();
    expect(findDuplicateKey('{"s":"quote \\" and brace {","s":0}')).toBe("s");
    expect(() => parseJsonStrict('{"a":1,"a":2}')).toThrow('duplicate object key "a"');
  });

  test("a report with a repeated verdict key is invalid offline", async () => {
    const dir = await temp("strict-json-");
    const report = syntheticReportV3();
    const text = JSON.stringify(report);
    const path = join(dir, "report.json");
    await writeFile(path, text.replace(/^\{/, `{"verdict":"FAIL",`));
    const inspection = await inspectReportFile(path, { command: "digest" });
    expect(inspection.valid).toBe(false);
    expect(inspection.problems.join("\n")).toContain("duplicate object key");
  });
});

describe("rejection evidence", () => {
  const script = { codeHash: `0x${"11".repeat(32)}`, hashType: "type", args: "0x" };
  const rpc = { code_hash: script.codeHash, hash_type: script.hashType, args: script.args };
  const tx = { inputs: [{}], outputs: [{ lock: rpc, type: null }] };
  const good = { kind: "script", rpcCode: -302, code: -11, source: { cell: "output", index: 0 }, role: "lock", script, scriptHash: scriptHash(script) };

  test("accepts exactly what the runner writes", () => {
    expect(() => assertRejectionEvidence({ observedStatus: "rejected", rejection: good, transaction: tx }, "s")).not.toThrow();
    expect(() => assertRejectionEvidence({ observedStatus: "rejected", rejection: { ...good, source: { cell: "input", index: 0 } }, transaction: tx }, "s")).not.toThrow();
    expect(() => assertRejectionEvidence({ observedStatus: "rejected", rejection: { kind: "node", reason: "x" }, transaction: tx }, "s")).not.toThrow();
    expect(() => assertRejectionEvidence({ observedStatus: "committed", transaction: tx }, "s")).not.toThrow();
  });

  test.each([
    ["a node rejection carrying a script code", { observedStatus: "rejected", rejection: { kind: "node", code: -11 } }, "unexpected code"],
    ["a script hash that is not the script's", { observedStatus: "rejected", rejection: { ...good, scriptHash: `0x${"00".repeat(32)}` } }, "does not match the recorded script"],
    ["a source outside the transaction", { observedStatus: "rejected", rejection: { ...good, source: { cell: "input", index: 99 } } }, "input 99 is not in the transaction"],
    ["a script that differs from the output's", { observedStatus: "rejected", rejection: { ...good, role: "type" } }, "has no type script"],
    ["a script rejection without its group", { observedStatus: "rejected", rejection: { kind: "script", rpcCode: -302, code: -11 } }, "missing source"],
    ["a committed step with a rejection", { observedStatus: "committed", rejection: { kind: "node" } }, "committed step cannot carry"],
    ["a rejected step without a rejection", { observedStatus: "rejected" }, "must carry rejection evidence"],
  ])("refuses %s", (_label, step, message) => {
    expect(() => assertRejectionEvidence({ ...step, transaction: tx }, "s")).toThrow(message);
  });

  test("only script evidence satisfies expect.error.code", () => {
    expect(errorCodeSatisfied(undefined, undefined)).toBe(true);
    expect(errorCodeSatisfied(-11, { kind: "script", code: -11 })).toBe(true);
    expect(errorCodeSatisfied(-11, { kind: "node", code: -11 })).toBe(false);
    expect(errorCodeSatisfied(-11, { kind: "script", code: -12 })).toBe(false);
  });
});

describe("check-bundle on damaged bundles", () => {
  async function bundle(): Promise<string> {
    const root = await temp("hardening-bundle-");
    const run = join(root, ".ckb-verify", "runs", "run-a");
    await mkdir(run, { recursive: true });
    await writeFile(join(run, "report.json"), JSON.stringify(syntheticReportV2()));
    const out = join(root, "bundle");
    await packageEvidence({ projectRoot: root, outDir: out, repository: "example/repo", sourceSha: "a".repeat(40),
      workflow: { name: "Verify", job: "j", runId: "1", runAttempt: "1" }, knownSecrets: [], now: new Date("2026-11-02T00:00:00Z") });
    expect((await verifyBundle(out)).ok).toBe(true);
    return out;
  }

  test("a missing SHA256SUMS is invalid", async () => {
    const out = await bundle();
    await rm(join(out, "SHA256SUMS"));
    const result = await verifyBundle(out);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toContain("SHA256SUMS");
  });

  test("a SHA256SUMS that omits bundle.json is invalid", async () => {
    const out = await bundle();
    const sums = (await readFile(join(out, "SHA256SUMS"), "utf8")).split("\n").filter((line) => !line.endsWith("  bundle.json")).join("\n");
    await writeFile(join(out, "SHA256SUMS"), sums);
    const result = await verifyBundle(out);
    expect(result.ok).toBe(false);
    expect(result.problems).toContain("SHA256SUMS does not cover bundle.json");
  });

  test.each([
    ["a null report entry", (b: { reports: unknown[] }) => { b.reports.push(null); }, "reports[1] is not an object"],
    ["null digests", (b: { reports: Array<Record<string, unknown>> }) => { b.reports[0]!.digests = null; }, "lacks outcome/environment digests"],
  ])("%s in bundle.json is invalid, not a crash", async (_label, damage, message) => {
    const out = await bundle();
    const manifest = JSON.parse(await readFile(join(out, "bundle.json"), "utf8"));
    damage(manifest);
    await writeFile(join(out, "bundle.json"), JSON.stringify(manifest));
    const result = await verifyBundle(out);
    expect(result.ok).toBe(false);
    expect([...result.problems, ...result.reports.flatMap((r) => r.problems)].join("\n")).toContain(message);
  });
});

process.on("exit", () => { for (const d of directories) void rm(d, { recursive: true, force: true }); });
