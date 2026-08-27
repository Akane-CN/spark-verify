import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";

export function canonicalJson(value: unknown): string {
  return canonicalize(value);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function canonicalSha256(value: unknown): string {
  return sha256Bytes(new TextEncoder().encode(canonicalJson(value)));
}
