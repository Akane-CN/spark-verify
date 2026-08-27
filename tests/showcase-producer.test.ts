import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { sporeScriptInfoFromSystemScripts } from "../showcases/ckb-ugmp/spore";

const root = join(import.meta.dir, "..");
const producer = join(root, "showcases", "secp-transfer", "produce.ts");
const ckbUgmpProducer = join(root, "showcases", "ckb-ugmp", "produce.ts");

describe("secp transfer showcase producer boundary", () => {
  test("fails before touching the chain when runner context is missing", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", producer, "committed"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("CKB_VERIFY_RESULT");
  });

  test("contains no transaction submission call", async () => {
    const source = await Bun.file(producer).text();

    expect(source).toContain("signTransaction");
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
  });
});

describe("CKB-UGMP showcase producer boundary", () => {
  test("injects the exact fresh OffCKB Spore deployment with local V2 cobuild semantics", () => {
    const script: ReturnType<typeof sporeScriptInfoFromSystemScripts> = {
      codeHash: `0x${"11".repeat(32)}`,
      hashType: "data2",
      cellDeps: [
        {
          cellDep: {
            outPoint: { txHash: `0x${"22".repeat(32)}`, index: 3 },
            depType: "code",
          },
        },
      ],
    };

    expect(
      sporeScriptInfoFromSystemScripts({ devnet: { spore: { script } } }),
    ).toEqual({ ...script, cobuild: true });
  });

  test("pins the Spore SDK used by the upstream revision", async () => {
    const packageJson = await Bun.file(join(root, "package.json")).json();

    expect(packageJson.dependencies?.["@ckb-ccc/spore"]).toBe("1.5.17");
  });

  test("keeps the adapted mint headless, deterministic, and runner-owned", async () => {
    const source = await Bun.file(ckbUgmpProducer).text();

    expect(source).toContain("createSpore");
    expect(source).toContain("sporeScriptInfoFromSystemScripts");
    expect(source).toContain("scriptInfo,");
    expect(source).toContain('clusterMode: "skip"');
    expect(source).toContain("completeFeeBy(signer, 1_000n)");
    expect(source).toContain("signTransaction");
    expect(source).toContain("GAME_PROFILE");
    expect(source).toContain('"application/json;dob=0"');
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
    expect(source).not.toContain("connector-react");
    expect(source).not.toContain("Pinata");
    expect(source).not.toContain("SCRIPTS_SPORE_TESTNET");
    expect(source).not.toContain("SCRIPTS_SPORE_MAINNET");
    expect(source).not.toContain("ClientPublicTestnet");
    expect(source).not.toContain("ClientPublicMainnet");
  });

  test("fails before touching the chain when runner context is missing", () => {
    const result = Bun.spawnSync({
      cmd: [process.execPath, "run", ckbUgmpProducer, "committed"],
      cwd: root,
      env: { PATH: process.env.PATH ?? "" },
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr.toString()).toContain("CKB_VERIFY_RESULT");
  });
});
