# witness_lock

A tiny CKB lock script (RV64I ELF, 308 bytes) assembled by [`build.ts`](build.ts) with no external
toolchain. The built binary is [`../build/witness_lock`](../build/witness_lock).

## Behaviour

1. `LOAD_SCRIPT` (2052) into a 256-byte stack buffer; read the `args` offset from the molecule
   `Script` table header (byte 12) and the `args` length (u32 LE) at that offset.
2. `LOAD_WITNESS` (2074) for index 0 of source `GROUP_INPUT` (`0x0100000000000001`) with a 1-byte
   buffer. The witness is treated as raw bytes, not `WitnessArgs`.
3. Succeed iff args and witness are both non-empty and `witness[0] == args[0]`.
4. `EXIT` (93) with the code below.

| Exit | Meaning |
| ---: | --- |
| 0 | first witness byte equals first args byte |
| 1 | `LOAD_SCRIPT` failed (or `args` offset not inside the 256-byte buffer) |
| 2 | empty `args` |
| 3 | `LOAD_WITNESS` failed (e.g. no witness at index 0 of the group) |
| 4 | empty witness |
| 42 | first bytes differ |

The ELF has one `PT_LOAD` (R|X) segment covering the whole file at vaddr `0x10000`, entry at
`0x10078`, and no section headers; CKB-VM (checked with ckb-debugger 1.1.1, hash types `data`,
`data1`, `data2`) accepts it.

## Rebuild and check

```sh
bun run showcases/repository-script/lock/build.ts            # writes build/witness_lock
bun run showcases/repository-script/lock/build.ts --listing  # also prints the instruction listing
bun run showcases/repository-script/lock/build.ts --check    # exit 1 if the committed binary differs
bun test tests/witness-lock.test.ts                          # build check, ELF sanity, ckb-debugger runs
```

The build is byte-for-byte deterministic.

- sha256: `4b84d34447f4ddc27a141e8c7a4c394be07eb599084b822103432e01db048787`
- CKB data hash (blake2b-256, `ckb-default-hash`): `0xa8c6406f855b45e3cba6dd103ea2f217b67a5eea65791f9a93f6e4b26bd4a273`
