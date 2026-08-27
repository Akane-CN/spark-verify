import { describe, expect, test } from "bun:test";
import { ManifestError, parseManifestText } from "../src/manifest";

const VALID = `
[meta]
name = "secp-transfer"
spec = "0.1.0-draft.3"
description = "runner-owned transfer"

[toolchain]
ckb = "0.209.0"
offckb = "0.4.13"

[replay]
dependencies = []

[setup]
accounts = 2

[[step]]
name = "transfer"
run = "bun run showcases/secp-transfer/produce.ts committed"
timeout = "45s"
expect.tx = "committed"

[[step.assert.cell]]
out_point = { step = "transfer", index = 0 }
count = 1
`;

function replace(source: string, from: string, to: string): string {
  const result = source.replace(from, to);
  if (result === source) throw new Error(`test replacement did not match: ${from}`);
  return result;
}

function expectManifestError(source: string, message: string): void {
  expect(() => parseManifestText(source, "verify.toml")).toThrow(ManifestError);
  expect(() => parseManifestText(source, "verify.toml")).toThrow(message);
}

describe("parseManifestText", () => {
  test("normalizes the supported manifest subset", () => {
    const manifest = parseManifestText(VALID, "verify.toml");

    expect(manifest).toEqual({
      meta: {
        name: "secp-transfer",
        spec: "0.1.0-draft.3",
        description: "runner-owned transfer",
      },
      toolchain: { ckb: "0.209.0", offckb: "0.4.13" },
      replay: { dependencies: [] },
      setup: { accounts: 2 },
      steps: [
        {
          name: "transfer",
          run: "bun run showcases/secp-transfer/produce.ts committed",
          timeoutMs: 45_000,
          expect: { tx: "committed" },
          assertions: [
            {
              kind: "cell",
              outPoint: { step: "transfer", index: 0 },
              count: 1,
            },
          ],
        },
      ],
      assertions: [],
    });
  });

  test("rejects unknown nested keys with their manifest path", () => {
    const source = replace(VALID, 'expect.tx = "committed"', 'expect.tx = "committed"\nexpect.typo = true');

    expectManifestError(source, "step[0].expect.typo is not supported");
  });

  test("rejects a vacuous claim set", () => {
    const source = VALID.replace('expect.tx = "committed"\n', "").replace(/\n\[\[step\.assert\.cell\]\][\s\S]*$/, "\n");

    expectManifestError(source, "manifest must declare at least one expectation or assertion");
  });

  test("rejects duplicate step names", () => {
    const source = `${VALID}\n[[step]]\nname = "transfer"\nrun = "true"\n`;

    expectManifestError(source, 'step name "transfer" is duplicated');
  });

  test("rejects output references to later steps", () => {
    const source = replace(VALID, 'step = "transfer"', 'step = "later"') + '\n[[step]]\nname = "later"\nrun = "true"\n';

    expectManifestError(source, 'step[0].assert.cell[0].out_point.step must reference this or an earlier step');
  });

  test("rejects invalid or unsafe output indices", () => {
    const negative = replace(VALID, "index = 0", "index = -1");
    const unsafe = replace(VALID, "index = 0", "index = 9007199254740992");

    expectManifestError(negative, "step[0].assert.cell[0].out_point.index must be a non-negative safe integer");
    expectManifestError(unsafe, "step[0].assert.cell[0].out_point.index must be a non-negative safe integer");
  });

  test("requires the implemented spec and OffCKB adapter versions", () => {
    expectManifestError(
      replace(VALID, 'spec = "0.1.0-draft.3"', 'spec = "0.1.0-draft.4"'),
      'meta.spec must equal "0.1.0-draft.3"',
    );
    expectManifestError(
      replace(VALID, 'offckb = "0.4.13"', 'offckb = "0.4.12"'),
      'toolchain.offckb must equal "0.4.13"',
    );
  });

  test("validates timeout and account bounds", () => {
    expectManifestError(replace(VALID, 'timeout = "45s"', 'timeout = "0s"'), "step[0].timeout must be between 1s and 600s");
    expectManifestError(replace(VALID, "accounts = 2", "accounts = 21"), "setup.accounts must be an integer between 1 and 20");
  });

  test("rejects replay dependencies not implemented by the feasibility slice", () => {
    const source = replace(VALID, "dependencies = []", 'dependencies = ["external_time"]');

    expectManifestError(source, "replay.dependencies must be empty in the MVP runner");
  });
});
