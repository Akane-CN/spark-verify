import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveSoMoScriptInfos } from "../showcases/somo-pixel-territory/script-info";

const root = join(import.meta.dir, "..");
const producer = join(root, "showcases", "somo-pixel-territory", "produce.ts");

describe("SoMo Pixel Territory showcase producer boundary", () => {
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

  test("derives Cluster and ACP script infos only from the runner export", () => {
    const dep = (seed: string) => ({
      cellDep: {
        outPoint: { txHash: `0x${seed.repeat(64)}`, index: 0 },
        depType: "code",
      },
    });
    const systemScripts = {
      devnet: {
        secp256k1_blake160_sighash_all: {
          script: { codeHash: `0x${"1".repeat(64)}`, hashType: "type", cellDeps: [dep("a")] },
        },
        anyone_can_pay: {
          script: { codeHash: `0x${"2".repeat(64)}`, hashType: "type", cellDeps: [dep("b")] },
        },
        dao: {
          script: { codeHash: `0x${"3".repeat(64)}`, hashType: "type", cellDeps: [dep("c")] },
        },
        spore_cluster: {
          script: { codeHash: `0x${"4".repeat(64)}`, hashType: "data2", cellDeps: [dep("d")] },
        },
      },
    };

    const resolved = resolveSoMoScriptInfos(systemScripts);

    expect(resolved.cluster).toEqual({ ...systemScripts.devnet.spore_cluster.script, cobuild: true });
    expect(resolved.anyoneCanPay).toEqual(systemScripts.devnet.anyone_can_pay.script);
    expect(resolved.secp256k1).toEqual(systemScripts.devnet.secp256k1_blake160_sighash_all.script);
    expect(resolved.dao).toEqual(systemScripts.devnet.dao.script);
  });

  test("pins the exact Spore canary declared by the upstream revision", async () => {
    const packageJson = await Bun.file(join(root, "package.json")).json();

    expect(packageJson.dependencies?.["@ckb-ccc/spore"]).toBe(
      "0.0.0-canary-20251025011602",
    );
  });

  test("keeps Cluster construction deterministic and runner-owned", async () => {
    const source = await Bun.file(producer).text();

    expect(source).toContain("createSporeCluster");
    expect(source).toContain("resolveSoMoScriptInfos");
    expect(source).toContain("scriptInfo: scriptInfos.cluster");
    expect(source).toContain("scriptInfos.anyoneCanPay.cellDeps");
    expect(source).toContain("completeFeeBy(signer, 1_000n)");
    expect(source).toContain("signOnlyTransaction");
    expect(source).not.toContain("sendTransaction");
    expect(source).not.toContain("send_transaction");
    expect(source).not.toContain("SCRIPTS_CLUSTER_TESTNET");
    expect(source).not.toContain("SCRIPTS_CLUSTER_MAINNET");
    expect(source).not.toContain("VITE_CKB_NETWORK");
  });
});
