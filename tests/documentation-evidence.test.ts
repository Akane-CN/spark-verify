import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { verifyEvidenceDigests } from "../src/report";
import type { CkbVerifyReport } from "../src/runner";

const SAMPLE_REPORT = new URL("../docs/examples/secp-transfer-committed-report.json", import.meta.url);
const REPORT_GUIDE = new URL("../docs/evidence-report.md", import.meta.url);
const SOURCE_MANIFEST = new URL("../showcases/secp-transfer/verify.committed.toml", import.meta.url);
const SOURCE_COMMIT = "8be27c1fb8c880cd3acc01726d9895b258bfc7b6";
const SAMPLE_SHA256 = "95c87133d477bb9bb9f0176d3f7f96bb9db87de849e608a1d8d361a2af0b14a6";

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
  expect(report.environment.sourceRevision).toEqual({
    gitCommit: SOURCE_COMMIT,
    dirty: false,
    dirtyDigest: null,
  });
  const manifest = await Bun.file(SOURCE_MANIFEST).text();
  expect(report.environment.manifestSha256).toBe(`sha256:${createHash("sha256").update(manifest).digest("hex")}`);
  expect(() => verifyEvidenceDigests(report)).not.toThrow();

  const guide = await Bun.file(REPORT_GUIDE).text();
  expect(guide).toContain(SOURCE_COMMIT);
  expect(guide).toContain(SAMPLE_SHA256);
  expect(guide).toContain(report.digests.outcome);
  expect(guide).toContain(report.digests.environment);
});
