import { describe, expect, test } from "bun:test";
import { canonicalJson, canonicalSha256, sha256Bytes } from "../src/canonical";

describe("canonical JSON evidence", () => {
  test("matches the RFC 8785 canonicalization example", () => {
    const value = {
      numbers: [333333333.33333329, 1e30, 4.5, 2e-3, 1e-27],
      string: "€$\u000f\nA'B\"\\\"/",
      literals: [null, true, false],
    };

    expect(canonicalJson(value)).toBe(
      "{\"literals\":[null,true,false],\"numbers\":[333333333.3333333,1e+30,4.5,0.002,1e-27],\"string\":\"€$\\u000f\\nA'B\\\"\\\\\\\"/\"}",
    );
  });

  test("prefixes lowercase SHA-256 digests", () => {
    expect(sha256Bytes(new TextEncoder().encode("abc"))).toBe(
      "sha256:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(canonicalSha256({ b: 2, a: 1 })).toBe(
      "sha256:43258cff783fe7036d8a43033f830adfc60ec037382473548ac742b888292777",
    );
  });
});
