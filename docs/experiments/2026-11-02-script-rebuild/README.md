# Script rebuild experiment, 2026-11-02

Five CKB ecosystem scripts were rebuilt from public source and compared with the bytes deployed on chain. All five are byte-identical to their live cells. Only one, xUDT, reproduces by following its own repository's documented recipe. The other four needed information that is not recorded anywhere.

This directory retains the rebuilt binaries, the raw chain reads and the two small tools used to compute hashes. Direction and design discussion live in [issue #39](https://github.com/Akane-CN/spark-verify/issues/39).

## What this is and is not

- It is a one-off experiment record for a possible post-v0.1 direction. It is not part of the `ckb-verify` package, the v0.1 contract, or the Spark application.
- It is **not** a `ckb-verify` evidence bundle. `ckb-verify check-bundle` does not apply. There is no report, no outcome digest and no signature.
- A match shows that the rebuilt bytes equal the on-chain cell data. It says nothing about whether a script is correct or safe. It is not an audit.
- Chain data was read from the public RPC nodes `mainnet.ckb.dev` and `testnet.ckb.dev`. The reads trust those nodes. The block numbers and hashes they returned are recorded so that anyone can repeat the reads against a node of their choice.

## Results

| Script | Network and live cell | Matching source | Toolchain | CKB data hash | Reproducible from its own docs |
| --- | --- | --- | --- | --- | --- |
| xUDT | mainnet `0xc07844ce21b38e4b071dd0e1ee3b0e27afd8d7532491327f39b786343f558ab7#0` | nervosnetwork/ckb-production-scripts `abdcb11` | `nervos/ckb-riscv-gnu-toolchain@sha256:aae8a3f79705f67d505d1f1d5ddc694a4fd537ed1c7e9622420a470d59ba2ec3` | `0x50bd8d6680b8b9cf98b73f3c08faf8b2a21914311954118ad6609be6e78a1b95` | Yes |
| Omnilock | mainnet Type ID `0x9b819793…6f26`, live cell `0xc76edf469816aa22f416503c38d0b533d2a018e253e379f134c3985b3472c842#0` | cryptape/omnilock `cd764d7` | same as xUDT | `0x768f306681da232ceb0b94f436c5f813377179762a831c5ad8797bd4fd2d118d` | No |
| Nervos DAO | mainnet genesis `0xe2fb199810d49a4d8beec56718ba2593b665db9d52299a0f9e6e75416d73ff5c#2` | nervosnetwork/ckb-system-scripts `e19875b`; `865f4d7` builds the same bytes | `nervos/ckb-riscv-gnu-toolchain@sha256:7b168b4b109a0f741078a71b7c4dddaf1d283a5244608f7851f5714fbad273ba` | `0x32064a14ce10d95d4b7343054cc19d73b25b16ae61a6c681011ca781a60c7923` | No |
| Spore | mainnet `0x96b198fb5ddbd1eed57ed667068f1f1e55d07907b4c0dbd38675a69ea1b69824#0` | sporeprotocol/spore-contract tag `0.2.2-beta.1` | Rust 1.70.0 and `nervos/ckb-riscv-gnu-toolchain@sha256:5732afe996b2b88a37ed3c0e4deb948e9d2a6936fb4b52d4e7a0dc5ad330c306` | `0x4a4dce1df3dffff7f8b2cd7dff7303df3b6150c9788cb75dcf6747247132b9f5` | No |
| Spore cluster | mainnet, documented `code_hash` only | same as Spore | same as Spore | `0x7366a61534fa7c7e6225ecc0d828ea3b5366adec2b58206f2ee84995fe030075` | No |
| ckb-js-vm | **testnet** Type ID `0x3e9b6bea…bed7`, live cell `0x756fdaf0d1ba1d2e03dc13c71c967b24021bc054893a766ccee6879c468892d2#0` | nervosnetwork/ckb-js-vm `3d966c3` | LLVM 19.1.7 official release, used as a **substitute** for the pinned image | `0xbeb3f510a608fbe97654da3dddb35b0214f3dcec6e252141720e9c9c32a6a461` | No |

Mainnet was read at block 20903417, hash `0x23637d5b16b9cb6d2e597e3e5ded2c0ce71b709922a192afae6299578babae4c`. Testnet was read at block 22942120, hash `0x4c761c920f5f2dc9dd465ef80ce966d665fe9b8062d050554e632e1b61fe68dc`. ckb-js-vm has no documented mainnet deployment, so its testnet deployment was used.

## What each match required

- **xUDT.** The repository's Docker recipe, `make build/xudt_rce` in the pinned image, matched on the first try.
- **Omnilock.** The Docker recipe matched only at `cd764d7`. That commit reached the repository four minutes after the deployment block: the commit is dated 14:34:58 +0800, block 12017064 is dated 14:30:50 +0800. The previous commit, `54541e5`, builds a different binary, kept here as `nonmatching/omni_lock-54541e5`. Nothing records which revision was deployed.
- **Nervos DAO.** `c/protocol.h` is not in the repository. The build downloads `blockchain.mol` from nervosnetwork/ckb at `d75e4c56ffa40e17fd2fe477da3f98c5578edcd1` and generates the header with moleculec 0.4.1. moleculec is not in the pinned image.
- **Spore.** The documented `capsule build --release -- --features release_export` cannot be replayed literally. capsule 0.10.2 adds `--remap-path-prefix=$HOME=~ --remap-path-prefix=$PWD=`, so the bytes depend on the original builder's paths. The layout was recovered from two strings left in the on-chain binary, shown below. The five contracts must also be built in capsule's order, because `spore`'s `build.rs` embeds the hashes of three of the others.

  ```text
  ~/.cargo/registry/src/index.crates.io-6f17d22bba15001f/ckb-std-0.14.3/src/high_level.rs
  lib/utils/src/mime.rs
  ```

- **ckb-js-vm.** The pinned image `cryptape/llvm-n-rust@sha256:d6d1f9a6656039273210de91913c828f5b4aa4a3282d2c93ed19bcb7bbf728fe` could not be pulled: Docker Hub answered HTTP 429 and `mirror.gcr.io` held the manifest without its layers. The official LLVM 19.1.7 release, run in `buildpack-deps:trixie`, produced identical bytes. The image's own Dockerfile pins only the LLVM and Rust versions; its base image and `apt-get` steps are unpinned.

The docs.nervos.org page for ckb-js-vm still lists the spent testnet cell `0xf594e7de…4494#0` and SHA-256 `898260099d49ef84a1fb10f4aae7dae8ef5ec5b34d2edae29a78981fd084f1ed`. The live Type ID cell now holds the binary with SHA-256 `721318de24bff4d8b26d20d4d05a9b8e79c04dadfb29da3fd0863e2b9f0da8c4`, which matches `checksums.txt` at the ckb-js-vm repository HEAD.

## Files

| Path | Content |
| --- | --- |
| `rebuilt/` | The six rebuilt binaries listed in the results table |
| `nonmatching/omni_lock-54541e5` | Omnilock built from the last commit before deployment, for contrast |
| `ckb-data-hashes.txt` | CKB data hash of every binary in this directory |
| `chain-reads.json` | Raw output of `tools/fetch_onchain.py` at the recorded blocks. Its `file` fields name working copies that are not retained here |
| `tools/ckb_data_hash.py` | Prints CKB data hash, SHA-256 and size of each file argument |
| `tools/fetch_onchain.py` | Reads the five documented cells, the live Type ID cells and the tip through public RPC |
| `SHA256SUMS` | SHA-256 of every other file in this directory |

## Verify this record

The first two checks run offline. The third reads the chain again and needs network access and `curl`.

```bash
cd docs/experiments/2026-11-02-script-rebuild
sha256sum -c SHA256SUMS
python3 -I tools/ckb_data_hash.py rebuilt/* nonmatching/*   # compare with ckb-data-hashes.txt and the table
python3 -I tools/fetch_onchain.py /tmp/chain-reads           # compare each data_hash with the table
```

A CKB data hash is blake2b-256 with the personalisation `ckb-default-hash` over the file's bytes. For a `data1` script it equals the `code_hash`. For a Type ID script, compare it with the data hash of the live cell carrying that Type ID, which `fetch_onchain.py` reports.

## Rebuild from source

Each image is pinned by the digest found in that repository's Makefile or Cross.toml. During the experiment, Docker Hub rate-limited anonymous pulls. The nervos images were pulled from `mirror.gcr.io` and `buildpack-deps:trixie` from `public.ecr.aws`. A digest pin makes the source registry irrelevant to the bytes. All builds ran with `--network none`.

```bash
# xUDT
git clone https://github.com/nervosnetwork/ckb-production-scripts && cd ckb-production-scripts
git checkout abdcb11 && git submodule update --init --recursive
docker run --rm --network none -v "$PWD":/code \
  nervos/ckb-riscv-gnu-toolchain@sha256:aae8a3f79705f67d505d1f1d5ddc694a4fd537ed1c7e9622420a470d59ba2ec3 \
  bash -c 'cd /code && mkdir -p build && make build/xudt_rce'

# Omnilock, same image
git clone https://github.com/cryptape/omnilock && cd omnilock
git checkout cd764d7 && git submodule update --init --recursive
docker run --rm --network none -v "$PWD":/code \
  nervos/ckb-riscv-gnu-toolchain@sha256:aae8a3f79705f67d505d1f1d5ddc694a4fd537ed1c7e9622420a470d59ba2ec3 \
  bash -c 'cd /code && make build/omni_lock'

# Nervos DAO; moleculec 0.4.1 from `cargo install moleculec --version 0.4.1`
git clone https://github.com/nervosnetwork/ckb-system-scripts && cd ckb-system-scripts
git checkout e19875b && git submodule update --init --recursive
curl -L -o c/blockchain.mol \
  https://raw.githubusercontent.com/nervosnetwork/ckb/d75e4c56ffa40e17fd2fe477da3f98c5578edcd1/util/types/schemas/blockchain.mol
moleculec --language c --schema-file c/blockchain.mol > c/protocol.h
docker run --rm --network none -v "$PWD":/code \
  nervos/ckb-riscv-gnu-toolchain@sha256:7b168b4b109a0f741078a71b7c4dddaf1d283a5244608f7851f5714fbad273ba \
  bash -c 'cd /code && mkdir -p build && make specs/cells/dao'

# Spore; Rust 1.70.0 mounted at /rust, cargo home prefetched with `cargo +1.70.0 fetch --locked`
git clone https://github.com/sporeprotocol/spore-contract && cd spore-contract && git checkout 0.2.2-beta.1
docker run --rm --network none -v "$PWD":/project -v "$CARGO_HOME_PREFETCHED":/home/builder/.cargo \
  -v "$RUSTUP_HOME/toolchains/1.70.0-x86_64-unknown-linux-gnu":/rust:ro \
  -e HOME=/home/builder -e CARGO_HOME=/home/builder/.cargo -e CARGO_NET_OFFLINE=true \
  -e PATH=/rust/bin:/riscv/bin:/usr/bin:/bin \
  -e 'RUSTFLAGS=--remap-path-prefix=/home/builder=~ --remap-path-prefix=/project=' -w /project \
  nervos/ckb-riscv-gnu-toolchain@sha256:5732afe996b2b88a37ed3c0e4deb948e9d2a6936fb4b52d4e7a0dc5ad330c306 \
  bash -c 'mkdir -p build/release; for c in spore_extension_lua cluster cluster_proxy cluster_agent spore; do
    cargo build -p $c --release --target riscv64imac-unknown-none-elf --features release_export &&
    cp target/riscv64imac-unknown-none-elf/release/$c build/release/$c; done'

# ckb-js-vm; official LLVM-19.1.7-Linux-X64.tar.xz extracted to $LLVM
git clone https://github.com/nervosnetwork/ckb-js-vm && cd ckb-js-vm
git checkout 3d966c3 && git submodule update --init --recursive
docker run --rm --network none -v "$PWD":/code -v "$LLVM":/llvm:ro -e PATH=/llvm/bin:/usr/bin:/bin -w /code \
  buildpack-deps:trixie bash -c 'make clean && make all'
```

The LLVM release archive used had SHA-256 `4a5ec53951a584ed36f80240f6fbf8fdd46b4cf6c7ee87cc2d5018dc37caf679`. The experiment ran on Linux x86_64 with Docker 29.9.2.
