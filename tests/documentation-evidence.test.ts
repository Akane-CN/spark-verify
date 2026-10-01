import { expect, test } from "bun:test";
import Ajv2020 from "ajv/dist/2020";
import { createHash } from "node:crypto";
import { verifyEvidenceDigests } from "../src/report";
import type { CkbVerifyReport } from "../src/runner";

const SAMPLE_REPORT = new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url);
const REPORT_GUIDE = new URL("../docs/evidence-report.md", import.meta.url);
const SOURCE_MANIFEST = new URL("../showcases/secp-transfer/verify.committed.toml", import.meta.url);
const PROVENANCE_SCHEMA = new URL("../schemas/ckb-verify-provenance-v1.schema.json", import.meta.url);
const SOURCE_COMMIT = "2fd12ea291fba2c4c6f266934a29466df47265b0";
const SAMPLE_SHA256 = "40f2c99e860e945119e2cd8037a1f908beee07a89d35a0ee0b72f95d84fe6c71";

test("published committed report is clean, internally consistent feasibility evidence", async () => {
  const file = Bun.file(SAMPLE_REPORT);
  expect(await file.exists()).toBe(true);

  const text = await file.text();
  expect(text).not.toMatch(
    /(?:gh[pousr]_|github_pat_|-----BEGIN .*PRIVATE KEY-----|\bsk-[A-Za-z0-9]{20,}|\bAKIA[0-9A-Z]{16}|\bxox[baprs]-[0-9A-Za-z-]{10,}|\bnpm_[A-Za-z0-9]{20,})/,
  );
  expect(text).not.toMatch(/"(?:privkey|privateKey|secretAccessKey|accessToken|refreshToken)"/i);
  expect(createHash("sha256").update(text).digest("hex")).toBe(SAMPLE_SHA256);

  const report = JSON.parse(text) as CkbVerifyReport;
  expect(report.schema).toBe("ckb-verify-report/1");
  expect(report.verdict).toBe("PASS");
  expect(report.evidence.name).toBe("secp-transfer-committed");
  expect(report.environment.schema).toBe("ckb-verify-environment/2");
  expect(report.environment.provenance.schema).toBe("ckb-verify-provenance/1");
  expect(report.environment.provenance.replay).toEqual({
    declaredDependencies: [],
    status: "stable",
    reasons: [],
  });
  expect(report.environment.provenance.source).toEqual({
    gitCommit: SOURCE_COMMIT,
    dirty: false,
    dirtyDigest: null,
  });
  const manifest = await Bun.file(SOURCE_MANIFEST).text();
  expect(report.environment.provenance.manifest.sha256).toBe(
    `sha256:${createHash("sha256").update(manifest).digest("hex")}`,
  );
  expect(report.environment.provenance.runtime.requestedVersion).toBe(
    report.environment.provenance.runtime.observedVersion,
  );
  expect(report.environment.provenance.lockfile.sha256).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(report.environment.provenance.binaries.ckb.expectedArchiveSha256).toBe(
    report.environment.provenance.binaries.ckb.archiveSha256,
  );
  const provenanceSchema = await Bun.file(PROVENANCE_SCHEMA).json();
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(provenanceSchema);
  expect(validate(report.environment.provenance), JSON.stringify(validate.errors)).toBe(true);
  expect(() => verifyEvidenceDigests(report)).not.toThrow();

  const guide = await Bun.file(REPORT_GUIDE).text();
  expect(guide).toContain(SOURCE_COMMIT);
  expect(guide).toContain(SAMPLE_SHA256);
  expect(guide).toContain(report.digests.outcome);
  expect(guide).toContain(report.digests.environment);
});
