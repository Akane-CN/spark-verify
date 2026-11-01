// Offline decoding of full-format CKB addresses (RFC 0021, bech32m, payload type 0x00) into lock scripts.
// No network and no known-script table: short and deprecated full formats are refused.
import type { ScriptHashType as HashType } from "./types";

const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
const BECH32M_CONST = 0x2bc830a3;

export interface DecodedAddress { prefix: "ckb" | "ckt"; codeHash: string; hashType: HashType; args: string }

function polymod(values: number[]): number {
  let checksum = 1;
  for (const value of values) {
    const top = checksum >>> 25;
    checksum = ((checksum & 0x1ffffff) << 5) ^ value;
    for (let i = 0; i < 5; i += 1) if ((top >>> i) & 1) checksum ^= GENERATOR[i]!;
  }
  return checksum >>> 0;
}

function expandPrefix(prefix: string): number[] {
  const out: number[] = [];
  for (const char of prefix) out.push(char.charCodeAt(0) >>> 5);
  out.push(0);
  for (const char of prefix) out.push(char.charCodeAt(0) & 31);
  return out;
}

function convertBits(data: number[], from: number, to: number): number[] | null {
  let acc = 0, bits = 0;
  const out: number[] = [];
  const max = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) { bits -= to; out.push((acc >>> bits) & max); }
  }
  if (bits >= from || ((acc << (to - bits)) & max) !== 0) return null;
  return out;
}

/** Decodes a full-format bech32m CKB address or throws with the reason. */
export function decodeFullAddress(address: string): DecodedAddress {
  if (typeof address !== "string" || address.length < 8 || address.length > 1023) throw new Error("address must be a bech32m string");
  if (address !== address.toLowerCase()) throw new Error("address must be lowercase");
  const separator = address.lastIndexOf("1");
  if (separator < 1) throw new Error("address lacks a bech32m separator");
  const prefix = address.slice(0, separator), body = address.slice(separator + 1);
  if (prefix !== "ckb" && prefix !== "ckt") throw new Error("address prefix must be ckb or ckt");
  if (body.length < 6) throw new Error("address is too short");
  const values: number[] = [];
  for (const char of body) {
    const index = CHARSET.indexOf(char);
    if (index === -1) throw new Error("address contains a non-bech32 character");
    values.push(index);
  }
  if (polymod([...expandPrefix(prefix), ...values]) !== BECH32M_CONST) throw new Error("address checksum is invalid (bech32m required)");
  const bytes = convertBits(values.slice(0, -6), 5, 8);
  if (bytes === null) throw new Error("address payload padding is invalid");
  if (bytes[0] !== 0x00) throw new Error("only full-format addresses (payload type 0x00) are supported");
  if (bytes.length < 34) throw new Error("address payload is shorter than a code hash and hash type");
  const codeHash = `0x${Buffer.from(bytes.slice(1, 33)).toString("hex")}`;
  const hashTypes: Record<number, HashType> = { 0: "data", 1: "type", 2: "data1", 4: "data2" };
  const hashType = hashTypes[bytes[33]!];
  if (hashType === undefined) throw new Error("address hash type byte is unsupported");
  return { prefix, codeHash, hashType, args: `0x${Buffer.from(bytes.slice(34)).toString("hex")}` };
}
