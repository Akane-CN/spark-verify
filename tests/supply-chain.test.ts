import { describe, expect, test } from "bun:test";
import {
  assertAllowedAuditReport,
  assertAuditCommandResult,
  assertOffckbUsesExternalArchiveLibraries,
} from "../src/supply-chain";

const ELLIPTIC_WAIVER = {
  id: 1112030,
  url: "https://github.com/advisories/GHSA-848j-6mx2-7j84",
  title: "Elliptic Uses a Cryptographic Primitive with a Risky Implementation",
  severity: "low",
  vulnerable_versions: "<=6.6.1",
};

describe("supply-chain release gate", () => {
  test("accepts only the explicitly waived low-severity elliptic advisory", () => {
    expect(() => assertAllowedAuditReport({ elliptic: [ELLIPTIC_WAIVER] })).not.toThrow();
    expect(() => assertAllowedAuditReport({})).not.toThrow();
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

  test("rejects audit process failures and inconsistent exit codes", () => {
    expect(() => assertAuditCommandResult({}, 0)).not.toThrow();
    expect(() => assertAuditCommandResult({ elliptic: [ELLIPTIC_WAIVER] }, 1)).not.toThrow();
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
    ].join("\n");
    expect(() => assertOffckbUsesExternalArchiveLibraries(safe)).not.toThrow();
    expect(() =>
      assertOffckbUsesExternalArchiveLibraries(
        `${safe}\nconst adm_zip_1 = __importDefault(__nccwpck_require__(3858));`,
      ),
    ).toThrow("bundled vulnerable adm-zip import");
    expect(() =>
      assertOffckbUsesExternalArchiveLibraries(`${safe}\nconst tar = __importStar(__nccwpck_require__(7222));`),
    ).toThrow("bundled vulnerable tar import");
  });
});
