import { describe, expect, test } from "bun:test";
import * as supplyChain from "../src/supply-chain";
import {
  assertAllowedAuditReport,
  assertAuditCommandResult,
  assertOffckbUsesExternalLibraries,
} from "../src/supply-chain";

const ELLIPTIC_WAIVER = {
  id: 1112030,
  url: "https://github.com/advisories/GHSA-848j-6mx2-7j84",
  title: "Elliptic Uses a Cryptographic Primitive with a Risky Implementation",
  severity: "low",
  vulnerable_versions: "<=6.6.1",
};
const REVIEW_DATE = new Date("2026-10-26T00:00:00Z");

describe("supply-chain release gate", () => {
  test("rejects package-name/version drift and malformed installed metadata", () => {
    expect(supplyChain.assertPackageVersion).toBeFunction();
    for (const [name, version] of [
      ["@offckb/cli", "0.4.13"], ["adm-zip", "0.6.1"], ["tar", "7.5.22"],
      ["follow-redirects", "1.16.1"], ["fast-uri", "3.1.9"],
    ] as const) {
      expect(() => supplyChain.assertPackageVersion({ name, version }, name, version)).not.toThrow();
      for (const invalid of [null, [], {}, { name }, { name, version: "0.0.0" }, { name: "other", version }]) {
        expect(() => supplyChain.assertPackageVersion(invalid, name, version)).toThrow(`expected ${name}@${version}`);
      }
    }
  });

  test("accepts only the explicitly waived low-severity elliptic advisory", () => {
    expect(() => assertAllowedAuditReport({ elliptic: [ELLIPTIC_WAIVER] }, REVIEW_DATE)).not.toThrow();
    expect(() => assertAllowedAuditReport({})).not.toThrow();
  });

  test("expires the elliptic waiver at its UTC deadline without rejecting a clean audit", () => {
    const report = { elliptic: [ELLIPTIC_WAIVER] };
    expect(() => assertAllowedAuditReport(report, new Date("2026-11-24T23:59:59.999Z"))).not.toThrow();
    for (const now of [new Date("2026-11-25T00:00:00Z"), new Date("2026-12-01T00:00:00Z")]) {
      expect(() => assertAllowedAuditReport(report, now)).toThrow("waiver expired");
      expect(() => assertAuditCommandResult(report, 1, now)).toThrow("waiver expired");
      expect(() => assertAuditCommandResult({}, 0, now)).not.toThrow();
    }
    expect(() => assertAllowedAuditReport(report, new Date("invalid"))).toThrow("invalid audit review clock");
  });

  test("rejects high/moderate findings and unreviewed low findings", () => {
    expect(() =>
      assertAllowedAuditReport({
        "adm-zip": [{ ...ELLIPTIC_WAIVER, id: 1239030, severity: "high" }],
      }),
    ).toThrow("unapproved audit findings");
    expect(() =>
      assertAllowedAuditReport({
        mystery: [{ ...ELLIPTIC_WAIVER, id: 9999999, severity: "low" }],
      }),
    ).toThrow("unapproved audit findings");
  });

  test("does not widen the unexpired waiver to changed metadata or additional advisories", () => {
    for (const report of [
      { elliptic: [{ ...ELLIPTIC_WAIVER, id: 1112031 }] },
      { elliptic: [{ ...ELLIPTIC_WAIVER, severity: "moderate" }] },
      { elliptic: [{ ...ELLIPTIC_WAIVER, url: "https://github.com/advisories/other" }] },
      { other: [ELLIPTIC_WAIVER] },
      ...[1243098, 1243101, 1243104, 1243107].map(id => ({
        elliptic: [ELLIPTIC_WAIVER], "fast-uri": [{ ...ELLIPTIC_WAIVER, id }],
      })),
      ...[1242604, 1242605].map(id => ({
        elliptic: [ELLIPTIC_WAIVER], "follow-redirects": [{ ...ELLIPTIC_WAIVER, id, severity: "high" }],
      })),
    ]) {
      expect(() => assertAllowedAuditReport(report, REVIEW_DATE)).toThrow("unapproved audit findings");
    }
  });

  test("rejects audit process failures and inconsistent exit codes", () => {
    expect(() => assertAuditCommandResult({}, 0)).not.toThrow();
    expect(() => assertAuditCommandResult({ elliptic: [ELLIPTIC_WAIVER] }, 1, REVIEW_DATE)).not.toThrow();
    expect(() => assertAuditCommandResult({}, 2)).toThrow("unexpectedly exited with status 2");
    expect(() => assertAuditCommandResult({}, 1)).toThrow("reported findings without advisory data");
    expect(() => assertAuditCommandResult({ elliptic: [ELLIPTIC_WAIVER] }, 0)).toThrow(
      "returned advisory data with success status",
    );
  });

  test("requires every active OffCKB archive import to resolve to audited external packages", () => {
    const safe = [
      'const adm_zip_1 = __importDefault(require("adm-zip"));',
      'const adm_zip_1 = __importDefault(require("adm-zip"));',
      'const tar = __importStar(require("tar"));',
      'const tar = __importStar(require("tar"));',
      'followRedirects = require("follow-redirects");',
      'return server.listen(port, "127.0.0.1", () => {',
    ].join("\n");
    expect(() => assertOffckbUsesExternalLibraries(safe)).not.toThrow();
    expect(() => assertOffckbUsesExternalLibraries(`${safe}\nreturn server.listen(port, () => {`)).toThrow(
      "wildcard RPC proxy listen",
    );
    expect(() => assertOffckbUsesExternalLibraries(safe.replace('return server.listen(port, "127.0.0.1", () => {', ""))).toThrow(
      "exactly 1 loopback-bound RPC proxy listen",
    );
    expect(() =>
      assertOffckbUsesExternalLibraries(
        `${safe}\nconst adm_zip_1 = __importDefault(__nccwpck_require__(3858));`,
      ),
    ).toThrow("bundled vulnerable adm-zip import");
    expect(() =>
      assertOffckbUsesExternalLibraries(`${safe}\nconst tar = __importStar(__nccwpck_require__(7222));`),
    ).toThrow("bundled vulnerable tar import");
  });

  test("rejects a bundled, missing, duplicate, or changed redirect-library import", () => {
    const archiveImports = [
      'const adm_zip_1 = __importDefault(require("adm-zip"));',
      'const adm_zip_1 = __importDefault(require("adm-zip"));',
      'const tar = __importStar(require("tar"));',
      'const tar = __importStar(require("tar"));',
    ].join("\n");
    const redirectImport = 'followRedirects = require("follow-redirects");';
    const safe = `${archiveImports}\n${redirectImport}\nreturn server.listen(port, "127.0.0.1", () => {`;
    expect(() => assertOffckbUsesExternalLibraries(safe)).not.toThrow();
    expect(() => assertOffckbUsesExternalLibraries(`${safe}\n__nccwpck_require__(230)`)).toThrow(
      "bundled vulnerable follow-redirects import",
    );
    for (const invalid of [
      archiveImports,
      `${safe}\n${redirectImport}`,
      safe.replace('require("follow-redirects")', '__nccwpck_require__(999)'),
    ]) {
      expect(() => assertOffckbUsesExternalLibraries(invalid)).toThrow(
        "exactly 1 patched follow-redirects import",
      );
    }
  });
});
