# Mac 复现与验收手册（Codex 0.166.0 独立测试版）

本手册给出在你的 Mac 上复现诊断、源码运行验收、构建并启动独立测试包的完整命令。所有步骤都**不覆盖** `/Applications/OpenCreator.app`，**不使用**正式的 `~/.opencreator` 数据库与 Runtime Home，也不打印凭据。对照脚本和源码运行检查只读取 `~/.codex`：它们启动的每个 Codex 进程（包括 `--version`）都使用临时 `CODEX_HOME`。离线实测中把假的 `~/.codex` 同时作为源 home 和默认 home，跑完后其中只有原来的 `auth.json` 和 `config.toml`。唯一的例外是测试包里的图像生成功能，见第 5 节的注意事项。

> 这些步骤未在 Mac 上执行过（本次工作环境是云端 Linux 容器），执行结果请按第 6 节回填到 TEST_REPORT.md。

## 0. 前置条件

- macOS 与 Xcode。仓库的发布手册要求完整 Xcode 26 或更新（`docs/operations/opencreator-desktop-release-runbook.md`）。打包脚本实际调用的是 codesign、iconutil、plutil、ditto 等命令行工具，只装 Command Line Tools 是否够用未验证；第 4 步失败时请先安装完整 Xcode。
- Node 22、pnpm 9.15.0（`corepack enable` 即可）、Go ≥ 1.25（KrillinAI 构建需要；`GOTOOLCHAIN=auto` 可自动下载）。
- 已用自己的 ChatGPT 账号登录过官方 Codex App 或 CLI，`~/.codex/auth.json` 存在。如果你使用的是 keyring 存储（`~/.codex` 中没有 auth.json），请先按第 2.1 节建立一次独立的测试登录，第 3 步和第 5 步都改用它。
- 不要在执行这些命令的 shell 中导出 `OPENCREATOR_HOME`、`CODEX_HOME`、`CODEX_ACCESS_TOKEN`、`CODEX_SQLITE_HOME`、`OPENCREATOR_CODEX_RUNTIME_ROOT`、`OPENCREATOR_CODEX_BIN`、`OPENAI_API_KEY`、`VOLCENGINE_APP_ID`、`VOLCENGINE_ACCESS_TOKEN`。
- **不要在 Mac 上直接运行 daemon 测试套件**（`pnpm --filter @opencreator/daemon test` 或 `vitest run`）。其中 57 处测试调用 `buildServer` 时没有传 `codexHome`，会改写 `$CODEX_HOME` 或 `~/.codex/config.toml`：写入 `cli_auth_credentials_store="file"` 并整体重新序列化，注释丢失，keyring 设置被覆盖。本手册的步骤不需要它。如果确实要跑，先执行 `export CODEX_HOME="$(mktemp -d)"`。另外，定向运行单个测试文件时，仓库锁定的 pnpm 9.15.0 下 `pnpm --filter <pkg> test -- <文件>` 和不带 `--` 的写法都只运行该文件；但全局 pnpm 10 会把 `--` 原样传给 vitest，结果跑完整套件。所以请通过 corepack 使用仓库锁定的版本，或者直接去掉 `--`。

使用一个独立的工作副本（不影响你现有的 checkout）：

```bash
git clone --branch claude/funny-gauss-fclzeh https://github.com/Dannyxiuzq/OpenCreator.git OpenCreator-codex-0166
```

```bash
cd OpenCreator-codex-0166 && pnpm install --frozen-lockfile
```

```bash
pnpm --filter @opencreator/protocol build && pnpm --filter @opencreator/config build && pnpm --filter @opencreator/skill-market build && pnpm --filter @opencreator/writing-templates build && pnpm templates:compile
```

## 1. 备份 `~/.codex` 并记录正式数据的基准（用于证明测试未触碰正式数据）

先退出官方 Codex App/CLI 和正式 OpenCreator（含菜单栏图标），再在本机备份 `~/.codex`，否则正在写入的 sqlite 可能复制得不一致。备份中包含 `auth.json`，仅保存在本机，不要上传；测试结束后可删除：

```bash
B="$HOME/codex-home-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -m 700 "$B" && ditto ~/.codex "$B/dot-codex" && echo "$B"
```

记录基准（只记录修改时间、大小和路径，不读取内容；包括正式 Runtime Home 中的 Codex 状态库、sqlite 的 WAL 文件，以及 `~/.codex/tmp` 下两层内的辅助目录）：

```bash
{ stat -f '%m %z %N' ~/.opencreator/config.toml /Applications/OpenCreator.app/Contents/Info.plist; find ~/.opencreator/data ~/.opencreator/runtime -maxdepth 2 -name '*.sqlite*' -exec stat -f '%m %z %N' {} +; find ~/.codex -maxdepth 1 \( -name '*.sqlite*' -o -name config.toml -o -name auth.json -o -name tmp -o -name skills \) -exec stat -f '%m %z %N' {} +; find ~/.codex/tmp -mindepth 1 -maxdepth 2 -exec stat -f '%m %z %N' {} +; } 2>/dev/null | sort -k3 | tee "$HOME/opencreator-baseline-before.txt"
```

## 2. 同账号、同配置、同模型的版本对照（先诊断）

脚本用 OpenCreator 自己的同步函数，从 `~/.codex` 只读复制登录和配置到临时目录，然后分别用官方 0.149.0 和 0.166.0 运行 `model/list` 和一次 `Reply with exactly: OK`。二进制从 npm 下载，并校验 sha512。

```bash
node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex
```

如果要以正式安装里实际运行的二进制作为基线，先确认它就是官方 0.149.0。arm64 应为 `f4a74117b8142cda581c95ff753abf4508b5636d89682c1ed77e4a9249af8963`，Intel 应为 `c646bd178240bb50efd81c2f9919dd9124b126c815911f6c1b6db400786c5ccd`，取自 3.2.9 的 manifest：

```bash
shasum -a 256 /Applications/OpenCreator.app/Contents/Resources/codex-runtime/bin/codex
```

然后：

```bash
node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex --old-bin /Applications/OpenCreator.app/Contents/Resources/codex-runtime/bin/codex
```

输出中 `VERDICT:` 那一行的含义见 DIAGNOSIS.md 第 5 节。只有 `VERSION_GATED` 时才继续第 3 步以后；否则先按表排查认证、模型可用性或配置。

- 如果提示 access token 将在 30 分钟内过期：先用官方 Codex App 等它在原位置刷新 token（它在过期前几分钟、使用时刷新），退出官方 Codex 后重新执行第 1 节的基准记录，再重跑。不建议使用 `--allow-refresh`：刷新副本会轮换 refresh token，可能导致官方 Codex 需要重新登录。
- 两个脚本只接受 ChatGPT 登录。如果 `~/.codex/auth.json` 是 API key 登录，脚本会在发出任何请求前退出，不会产生按 API 计费的请求。
- 不想读取 `~/.codex` 时，可以改用一次独立的测试登录：`node scripts/codex-runtime-ab/codex-ab.mjs --login`。
- 报告保存在 `.tmp/codex-ab/run-*/report.json`。下载的二进制位于 `.tmp/codex-ab/bin/`，不含凭据。

可选：用上一步下载的两个 macOS 二进制离线复现历史读取与回滚探针（假账号、本地 mock，不读取 `~/.codex`），期望最后一行为 `RESULT: PASS`：

```bash
node scripts/codex-runtime-ab/thread-history-probe.mjs --old-bin "$(ls .tmp/codex-ab/bin/0.149.0-*/x/package/vendor/*/bin/codex)" --new-bin "$(ls .tmp/codex-ab/bin/0.166.0-*/x/package/vendor/*/bin/codex)"
```

### 2.1 keyring 用户：建立独立的测试登录

```bash
node scripts/codex-runtime-ab/codex-ab.mjs --login --keep-login
```

它会打开浏览器，用你自己的 ChatGPT 账号登录一次。凭据以 file 方式保存在 `.tmp/codex-ab/login-home/auth.json`（权限 0600），不改动 keyring 中的登录，同时完成一次版本对照。之后：

- 第 3 步改用 `--from-codex-home .tmp/codex-ab/login-home`。
- 第 5 步改用下面的命令启动测试包，让它从这个目录同步登录。Desktop 把启动时的 `CODEX_HOME` 当作要同步的本机 Codex home，自己的 Runtime Home 不受影响。从终端启动会继承 shell 的环境变量，所以命令里顺带去掉了付费服务的凭据变量：

```bash
env -u VOLCENGINE_APP_ID -u VOLCENGINE_ACCESS_TOKEN -u OPENAI_API_KEY CODEX_HOME="$PWD/.tmp/codex-ab/login-home" "$HOME/OpenCreator-Isolated/OpenCreator Codex 0166.app/Contents/MacOS/OpenCreator"
```

## 3. 源码运行验收（真实账号，独立数据目录）

先为本机架构准备并校验 0.166.0 Runtime（从 npm 下载，并校验 sha512 和逐文件 sha256）：

```bash
pnpm --filter @opencreator/desktop prepare:codex-runtime
```

然后用源码构建 daemon，走 OpenCreator 自己的 API 依次检查 9 项：readiness/账号/模型列表、对话、Creator Agent 流式输出、同线程续聊、重启后读取会话历史、重启后继续同一线程、命令审批、取消，以及 Krillin 短字幕翻译。

```bash
node --import tsx scripts/codex-runtime-ab/source-run-check.mjs --from-codex-home ~/.codex
```

- OpenCreator 的数据目录建在 `~/.opencreator-isolated/source-run/run-*`，结束后自动删除；报告保存在 `.tmp/codex-source-run/run-*/report.json`。数据目录不放在仓库里，是为了不让 Codex 把本仓库的 AGENTS.md 加进提示；也不放在系统临时目录，因为 Codex 在临时目录下的 home 中不创建 `apply_patch` 辅助链接。
- 服务商凭据文件指向该目录中一个不存在的 `.env.local`，并清除 `VOLCENGINE_*` 环境变量，因此不会读取 `~/.opencreator/.env.local` 中的付费凭据。
- 审批检查依赖真实模型是否真的请求提权。如果模型没有请求，结果记为 `UNVERIFIED`，不算通过。脚本只批准在检查项目目录中执行的 `touch approved.txt`；模型请求其他命令时会被拒绝，同样记为 `UNVERIFIED`。
- 任一项为 `FAIL` 时，进程退出码为 1。

### 3.1 Web 端同流程检查（建议）

AGENTS.md 要求修复一端时也检查另一端。`pnpm web:dev` 会自己启动 daemon；没有设置 `OPENCREATOR_CODEX_BIN` 时，它使用上一步准备好的 `apps/desktop/.pack/codex-runtime/bin/codex`。下面的命令按 Desktop 的方式设置环境：`CODEX_HOME` 指向独立目录中的 Runtime Home，`OPENCREATOR_LOCAL_CODEX_HOME` 指向要只读同步的 `~/.codex`，数据、默认项目和服务商凭据文件也都放进独立目录。不要让 `CODEX_HOME` 指向 `~/.codex`，否则 daemon 会把它当作 Runtime Home 并改写其中的 `config.toml`，启动探测也会在其中留下 `tmp/arg0*`。

```bash
W="$HOME/.opencreator-isolated/codex-0166-web"; env -u OPENCREATOR_CODEX_BIN -u CODEX_ACCESS_TOKEN -u CODEX_SQLITE_HOME -u VOLCENGINE_APP_ID -u VOLCENGINE_ACCESS_TOKEN CODEX_HOME="$W/home/runtime/codex" OPENCREATOR_LOCAL_CODEX_HOME="$HOME/.codex" OPENCREATOR_HOME="$W/home" OPENCREATOR_DEFAULT_PROJECT_ROOT="$W/Documents" OPENCREATOR_ENV_FILE="$W/home/.env.local" pnpm web:dev
```

在浏览器打开 `http://127.0.0.1:19861`，按第 5 节第 1 至 5 项操作，并与测试包的结果对照。开发模式下设置页显示的 Codex 版本来自实际运行的二进制，应为 `0.166.0`。keyring 用户把 `OPENCREATOR_LOCAL_CODEX_HOME` 换成 `$PWD/.tmp/codex-ab/login-home`。结束后按 Ctrl-C 停止，并删除 `$HOME/.opencreator-isolated/codex-0166-web`。

## 4. 构建独立测试包（ad-hoc 签名、不公证、独立 bundle id）

```bash
env -u CSC_LINK -u CSC_KEY_PASSWORD -u CSC_NAME -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u OPENCREATOR_DESKTOP_OFFICIAL_BUILD -u OPENCREATOR_SIGN_CREATOR_RUNTIME -u OPENCREATOR_NOTARIZE_MAC_APP -u OPENCREATOR_CODEX_RUNTIME_ROOT -u OPENCREATOR_HOME OPENCREATOR_DESKTOP_ISOLATED_PROFILE=codex-0166 pnpm --filter @opencreator/desktop package
```

- 只允许 `package`（即 `--dir`）。`package:signed`、`dist`、`release` 和官方构建都会拒绝隔离 profile。
- 构建结束会自动运行 `verify-package`：校验 Codex/Creator/Stickman Runtime 逐文件哈希、App 内嵌 Web 与当前 `apps/web/dist` 哈希一致、Fuses、codesign。
- 产物路径以构建日志中 `[desktop-package] 包根目录：` 那一行为准。通常是 `apps/desktop/release/mac-arm64/OpenCreator.app`；Intel 机器上可能是 `release/mac-x64/` 或 `release/mac/`，打包脚本两种都接受。下面的命令用通配符找到它，应只输出一个路径。

构建后核对：

```bash
A=$(ls -d apps/desktop/release/mac*/OpenCreator.app); echo "$A"; plutil -extract CFBundleIdentifier raw -o - "$A/Contents/Info.plist"; cat "$A/Contents/Resources/desktop-build-profile.json"; grep '"commit"' "$A/Contents/Resources/codex-runtime/manifest.json"; codesign --verify --deep --strict --verbose=2 "$A"; codesign -dv --verbose=4 "$A/Contents/Resources/codex-runtime/bin/codex" 2>&1 | grep -E "Authority=Developer ID|TeamIdentifier"; CODEX_HOME="$(mktemp -d)" "$A/Contents/Resources/codex-runtime/bin/codex" --version
```

期望结果：
- bundle id 为 `com.opencreator.desktop.isolated.codex-0166`。Info.plist 仍声明 `opencreator` scheme，原因是 electron-builder 无法从命令行移除数组配置。但测试包运行时不会把自己设为默认处理程序，见第 5 节。
- build profile 中有 `"isolatedProfile": "codex-0166"`。
- manifest 中的 commit 为 `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`。
- codex 的签名为 `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)`（TeamIdentifier `2DC432GLL2`），版本为 `codex-cli 0.166.0`。`--version` 使用临时 `CODEX_HOME`，因为 Codex 即使只打印版本也会在 home 的 `tmp/` 下创建辅助链接。

复制到独立位置（**不要**放进 `/Applications/OpenCreator.app`）：

```bash
mkdir -p "$HOME/OpenCreator-Isolated" && ditto "$(ls -d apps/desktop/release/mac*/OpenCreator.app)" "$HOME/OpenCreator-Isolated/OpenCreator Codex 0166.app"
```

### 4.1 打包 App 冒烟 E2E（建议）

```bash
pnpm --filter @opencreator/desktop e2e:package:smoke
```

- 它按 `release/opencreator-desktop-build-manifest.json` 找到刚构建的包，运行 24 个 `@package-smoke` 用例。用例使用临时的 `--user-data-dir`、`OPENCREATOR_HOME`、`CODEX_HOME`、默认项目目录等，不读写正式数据和 `~/.codex`。
- 其中 5 个用例以 bundled 模式启动包内真实的 0.166.0（不登录），所以它同时是“打包后的真实二进制能否启动”的门禁；其余用例使用假 Codex。
- 只对本手册构建的隔离 profile 包运行。非隔离构建每次启动都会把自己注册为 `opencreator://` 的默认处理程序，会抢走正式 App 的深链。

## 5. 启动测试包并完成真实验收

```bash
open -n "$HOME/OpenCreator-Isolated/OpenCreator Codex 0166.app"
```

测试包会自动使用以下独立位置：
- `~/Library/Application Support/OpenCreator Isolated codex-0166`（Electron userData 与单实例锁）
- `~/.opencreator-isolated/codex-0166/home`（配置、`data/app.sqlite`、`runtime/codex` 等 Runtime Home）
- `~/.opencreator-isolated/codex-0166/Documents`（默认项目）
- `~/.opencreator-isolated/codex-0166/home/.env.local`（服务商凭据文件，默认不存在）：测试包不会读取正式的 `~/.opencreator/.env.local`，因此不会使用其中的火山引擎等付费凭据

它不会把自己注册为 `opencreator://` 的默认处理程序，也不检查更新。正式 App 每次启动都会把自己设为默认处理程序，所以深链仍然打开正式 App。可以用下面的命令确认默认处理程序仍是 `com.opencreator.desktop`：

```bash
defaults read ~/Library/Preferences/com.apple.LaunchServices/com.apple.launchservices.secure.plist LSHandlers 2>/dev/null | grep -B2 -A3 opencreator
```
登录沿用 `~/.codex` 中你自己的 ChatGPT 登录（只读同步；keyring 用户按第 2.1 节的命令启动）。设置中模型来源应为“本机 Codex（ChatGPT 登录）”，不要切换到 OpenCreator 账号或积分。

> **注意：测试期间不要打开“Creator 服务”设置里的图像生成状态，也不要运行图像生成模板。** 这是 3.2.9 已有的设计：图像能力检查和“使用 ChatGPT 登录的原生生图”会以 `CODEX_HOME=~/.codex` 直接运行内置 Codex。
> - 状态检查会在 `~/.codex/tmp/arg0-*/` 留下辅助链接。
> - 原生生图会打开 `~/.codex` 的状态库，并把它迁移到 0.166.0 的结构。
>
> 本次升级不改变这一行为，但它不属于本次验收范围。如果误触，用第 1 节的备份恢复 `~/.codex`（ROLLBACK.md 第 1 节）。

在 App 中逐项验收，并把结果记入 TEST_REPORT.md 第 5 节的表格：

1. **真实模型响应**：设置页 Codex 状态显示 `0.166.0`、已登录（界面不显示 commit，commit 已在第 4 节核对）。新对话中选择 `gpt-6.1-terra`（或保持默认，此时使用 `~/.codex` 的模型），发送 `Reply with exactly: OK`，应正常回复，不出现 model_not_found 或“正在重连”。
2. **流式输出**：让它“写三段关于字幕历史的短文”，文字应逐步出现，而不是最后一次性出现。
3. **工具与审批**：在 read-only 或“需批准”权限下，让它“在当前项目里创建 approved.txt”。应弹出审批，批准后文件出现；拒绝时文件不出现。
4. **取消**：发起长任务，在输出过程中点击停止，任务应在数秒内变为已取消，不留残余进程。
5. **恢复**：完成一轮对话后完全退出测试包再打开，在同一会话继续追问上一轮内容，应能接上上下文；Creator 模板任务刷新后 Activity 和消息不重复。
6. **短字幕翻译**：用视频翻译模板，导入一段 10 至 20 句的短字幕（或短视频），翻译为简体中文。检查：
   - 任务完成，没有 `codex_completion_failed`。
   - 句数、时间轴与原文一致，没有截断或漏句（同时观察 `partial_answer` 是否导致拆分丢失）。
   - 没有出现积分或付费提示。

## 6. 验收后证明正式数据未变

先退出测试包、正式 OpenCreator 和官方 Codex App/CLI，再执行：

```bash
{ stat -f '%m %z %N' ~/.opencreator/config.toml /Applications/OpenCreator.app/Contents/Info.plist; find ~/.opencreator/data ~/.opencreator/runtime -maxdepth 2 -name '*.sqlite*' -exec stat -f '%m %z %N' {} +; find ~/.codex -maxdepth 1 \( -name '*.sqlite*' -o -name config.toml -o -name auth.json -o -name tmp -o -name skills \) -exec stat -f '%m %z %N' {} +; find ~/.codex/tmp -mindepth 1 -maxdepth 2 -exec stat -f '%m %z %N' {} +; } 2>/dev/null | sort -k3 | diff "$HOME/opencreator-baseline-before.txt" - && echo "production data unchanged"
```

说明：
- 如果正式 OpenCreator 在测试期间也在运行，它自己会更新 `app.sqlite`，此时 diff 的变化不能算作测试包造成的。建议测试期间退出正式 App。
- 官方 Codex App 或 CLI 在测试期间运行时，也会自己更新 `~/.codex` 下的数据库和 `tmp/`。建议测试期间同时退出官方 Codex，否则 diff 中的变化不能算作测试包造成的。

## 7. 清理

见 ROLLBACK.md 第 1 节。
