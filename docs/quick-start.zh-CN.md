# ckb-verify 简要使用说明

`ckb-verify` 用来给 CKB 交易流程做可重复执行的验收与回归测试。你在 `verify.toml` 里写下项目必须支持的交易流程和预期结果；它每次都在一条全新的本地 devnet 上执行，并逐条检查。

英文版见 [README 的 Quick start](../README.md#quick-start)。

## 环境要求

- Linux x64、[Bun](https://bun.sh) `1.2.19`、Node.js 22、`git`。其他平台没有验证过，不在支持范围内。
- 只在你信任的仓库里运行。`verify.toml` 会执行仓库自己的命令，工具不提供沙箱（见 [`SECURITY.md`](../SECURITY.md)）。

## 1. 下载安装包

从 [`v0.1.0` release](https://github.com/Akane-CN/spark-verify/releases/tag/v0.1.0) 下载安装包并核对校验和：

```bash
curl -LO https://github.com/Akane-CN/spark-verify/releases/download/v0.1.0/ckb-verify-0.1.0.tgz
curl -LO https://github.com/Akane-CN/spark-verify/releases/download/v0.1.0/SHA256SUMS
sha256sum -c SHA256SUMS
```

没有发布到 npm。想自己打包的话，在本仓库的检出里执行 `bun install --frozen-lockfile && bun run build`，会生成 `dist/ckb-verify-0.1.0.tgz`。

## 2. 接入你的项目

一条命令完成接入，接入脚本就在安装包里。加上 `--example` 会同时生成一份能直接跑通的 `verify.toml` 和示例交易脚本：

```bash
tar -xzf ckb-verify-0.1.0.tgz package/src/setup-project.ts
bun package/src/setup-project.ts ckb-verify-0.1.0.tgz /path/to/your-project --example
cd /path/to/your-project
git add -A && git commit -m "Add ckb-verify"     # 先提交，报告才不会被标记为 tainted
```

这条命令会做这些事：

- 把安装包复制到 `vendor/`，这样在 CI 里也能安装；
- 把随包附带的 OffCKB 安全补丁放到 `patches/`；
- 在 `package.json` 里加上依赖、补丁声明、`overrides` 和 Bun 版本；
- 把 `node_modules/` 和 `.ckb-verify/` 加进 `.gitignore`；
- 执行 `bun install`，并确认装好的版本号正确。

它可以重复执行，第二次不会改动任何东西。它不会覆盖你已有的 `verify.toml`；遇到与 `package.json` 现有值冲突的情况会报错停下，不会替你改。

## 3. 运行

```bash
bunx ckb-verify validate           # 只检查 verify.toml，不执行任何东西
bunx ckb-verify run                # 全新 devnet，执行每个步骤，检查每条声明
bunx ckb-verify ui                 # 本地控制台 http://127.0.0.1:4173/
```

`run` 的结果有三种：

| 输出 | 退出码 | 含义 |
| --- | --- | --- |
| `PASS` | 0 | 所有声明都通过 |
| `FAIL` | 1 | 至少一条声明没通过，会列出预期值和观测值 |
| `ERROR [阶段]` | 2 | 没有得出结论，并指出停在哪个阶段 |

`ERROR` 里的阶段说明了问题在谁那边。例如 `command` 阶段是你自己的命令出错，`devnet` 阶段是工具链或网络问题。

第一次运行会下载固定版本的 CKB。报告写在 `.ckb-verify/runs/` 下。

## 4. 改成你自己的流程

编辑 `verify.toml`，把 `verify/transfer.ts` 换成构造并签名你自己交易的代码：

- 每个步骤产生一笔交易。步骤的命令把签好名的交易写到 `CKB_VERIFY_RESULT` 指向的文件，不要自己提交，由 `ckb-verify` 提交（见 [README 的 Producer boundary](../README.md#producer-boundary)）。
- 要部署并测试自己的脚本，使用 spec `0.2.0` 的 `[setup.scripts]`（[0.2.0 词汇表](vocabulary-v0.2.md)，[完整示例](../showcases/repository-script/README.md)）。
- 可以声明的检查项见 [v0.1 词汇表](vocabulary-v0.1.md)：交易被提交或被拒绝、错误码和负责的脚本组、cycles 上限、留下的 Cell 和余额。

## 5. 放进 CI

用本仓库的可复用工作流，固定到某个提交：

```yaml
# 你的项目里的 .github/workflows/verify.yml
on: [push, pull_request]
jobs:
  verify:
    uses: Akane-CN/spark-verify/.github/workflows/ckb-verify-reusable.yml@<commit-sha>
    with:
      manifest: verify.toml
```

它会校验并运行 manifest，出现 `FAIL` 或 `ERROR` 时让 job 失败，并把报告保存为 artifact。它还会缓存校验过的 CKB 和 debugger 安装包。

拿到报告的任何人都可以离线复核：

```bash
bunx ckb-verify check-digest report.json
```

## 更多

- 手动安装步骤和工具会拒绝的情况：[安装指南](install.md)
- 控制台：[console.md](console.md)
- 离线校验：[offline-verification.md](offline-verification.md)
- 项目现状：[结项报告](reports/2026-11-10-closeout.md)
