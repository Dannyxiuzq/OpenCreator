# 测试报告：内置 Codex 0.149.0 → 0.166.0

> 日期：2026-11-02
> 分支：`claude/funny-gauss-fclzeh`（相对基线 `31c350b` 的三个代码提交，加本文档提交）
> 执行环境：Claude Code 云端 Linux 容器（x86_64），Node 22.23.4，pnpm 9.15.0，Go 1.24.7；没有 CJK 字体；没有 Mac；网络策略阻断 `chatgpt.com`、Electron headers 和 Chromium headless shell 的下载源。

本报告只列出**实际执行过**的检查。没有执行的项目一律标为“未验证”，并写明原因。

## 1. 结论一览

| 范围 | 状态 | 说明 |
| --- | --- | --- |
| 诊断：版本对照（离线、真实官方二进制） | 通过 | 第 3.6 节；真实账号对照 **未验证** |
| 来源与完整性（npm、GitHub 双渠道、manifest、篡改检测） | 通过 | 第 3.1 节 |
| 协议快照生成（可复现、确定性） | 通过 | 第 3.1 节 |
| 类型检查与编译（daemon、desktop） | 通过 | 第 3.2 节 |
| 定向测试 | 通过 | 第 3.3 节 |
| 真实二进制门禁（网关协议 16 项） | 通过（发现并修复 1 个夹具问题） | 第 3.4 节 |
| 源码运行（真实 0.166.0 + OpenCreator 服务端代码 + 离线 mock） | 9/9 通过 | 第 3.7 节；真实模型 **未验证** |
| 历史读取与回滚兼容（两版真实二进制，离线 mock） | 通过 | 第 3.9 节 |
| Web 端开发模式（MAC_RUNBOOK 3.1 的环境，经 Web 开发服务器调用 API，离线 mock） | 通过 | 第 3.10 节；浏览器界面 **未验证** |
| 全量回归（daemon、desktop 单元与集成） | 通过；1 个与本次无关的环境失败 | 第 3.8 节 |
| macOS 独立测试包构建、`verify-package`、打包 E2E、Web 端界面检查 | **未验证** | 只能在 Mac 上执行，见第 4 节 |
| 真实模型的响应、流式、工具与审批、取消、恢复、短字幕翻译 | **未验证** | 需要真实账号，见第 5 节 |

## 2. 验证分级

按 AGENTS.md，本次改动涉及 Codex Runtime、打包脚本和 Desktop 主进程（隔离 profile），属于 **P2**。在容器内完成了 P2 中可执行的部分：定向测试、类型检查、编译、真实二进制集成门禁、源码运行、Web 开发模式的 API 层检查和全量单元/集成回归。Desktop 打包、打包 App E2E 和 Web/Desktop 界面一致性门禁只能在 Mac 上执行，列入第 4 节。

本次没有修改 `apps/web` 代码，因此未运行 Web 测试；Web E2E 使用独立的假 Codex，与 Runtime 版本无关。

## 3. 已执行的检查

### 3.1 来源、完整性与协议快照

| 检查 | 结果 |
| --- | --- |
| npm `@openai/codex@0.166.0-{darwin-arm64,darwin-x64,linux-x64,win32-x64}` 的 sha512 与 registry `dist.integrity` 一致 | 4/4 一致 |
| 0.149.0 四个平台的 registry integrity 与仓库现有 manifest 一致 | 一致 |
| GitHub 官方发布资产（rust-v0.166.0）与 npm 包逐文件 sha256 比对 | darwin-arm64：40 个文件一致；darwin-x64：40 个一致；linux-x64：42 个一致；这三个平台的差异只有 `codex-package.json` 和 GitHub 多出的 `codex-exec-server`。Windows 的 zip 目录结构不同，只比对了 codex、code-mode-host、command-runner、sandbox-setup 四个二进制，均一致；voice 的 `manifest.json` 中可执行文件路径写法不同（voice 不收录） |
| manifest 逐文件 sha256 与 staged 体积 | darwin-arm64 342,185,560 B，darwin-x64 367,065,911 B，linux-x64 403,283,101 B，win32-x64 483,292,558 B（与独立 reader 的计算一致） |
| `prepare-codex-runtime.mjs` 用真实 0.166.0 linux-x64 包 staging | `ok: true`，`codex-cli 0.166.0`，文件清单与 manifest 完全一致 |
| 篡改检测：改动 staged 的 `codex-path/rg` 后执行 `verifyCodexRuntime` | 拒绝（`resource hash mismatch`），恢复后通过 |
| 修复后的生成器重新生成 0.149.0（`node apps/daemon/scripts/generate-codex-app-server-protocol.mjs --source-repo <codex clone> --tag rust-v0.149.0 --expected-commit 758ef40f50c1a458425c7cfbf1eb12cbc07af0b0 --output <…/.tmp/v0_149_0>`） | 与已提交的 `v0_149_0` 逐字节一致（`6670c9dc…`）。注意：非默认 tag 必须同时传 `--expected-commit`，否则生成器按默认 commit 校验，会直接报错退出 |
| 生成 0.166.0 两次并比对 | 一致；206 个文件；聚合哈希 `095d2414c3c711d94f67ec85a095ec2be313e5eed855ad7a60cb7adac51c9521`（与独立 reader 计算一致） |

### 3.2 类型检查与编译

| 命令 | 结果 |
| --- | --- |
| `pnpm --filter @opencreator/daemon typecheck` | 通过 |
| `pnpm --filter @opencreator/desktop typecheck` | 通过 |
| `pnpm -r typecheck`（全部 10 个 workspace 包，含未改动的 web、protocol、config 等） | 通过 |
| `pnpm --filter @opencreator/desktop build:main && build:preload && build:bootstrap` | 通过（编译产物中包含隔离 profile 逻辑） |
| `pnpm --filter @opencreator/daemon build` | 通过（`dist/codex/generated` 只有 `v0_166_0`） |
| `git diff --check 31c350b HEAD` | 无空白错误 |

### 3.3 定向测试

| 测试 | 结果 |
| --- | --- |
| daemon：`codex-app-server-protocol-0_166_0`、`codex-capabilities`、`codex-runtime-readiness`（含新增的账户类型映射用例）、`codex-runtime-routes`、`model-catalog-2026-08-05`、`codex-provider-config`、`codex-app-server-session-provider`（历史回退改为 `excludeTurns: true`）、`persistent-app-server-server-2026-07-28`、`approval-runtime`、`app-server-sessions-api` | 10 个文件、58 个测试通过（以临时目录作为 `CODEX_HOME` 运行） |
| desktop：`codex-runtime-package`（含新增的默认协议目录推导和四平台一致性用例）、`codex-resolver`、`runtime-profile`（新增 3 个）、`isolated-profile`（新增；把打包参数叠加到真实 `electron-builder.yml` 上，用 electron-builder 自身的 schema 校验 darwin、linux、win32）、`mac-signing`、`release-workflow`、`release-runtime-regressions`、`updater`、`deep-link-manager`、`protocol-path`、`daemon-output` | 11 个文件、91 个测试通过 |

审查中发现并修复：最初的隔离参数 `--config.protocols=null` 会被 electron-builder 当作字符串 `"null"`，schema 校验失败，会让 Mac 打包直接失败。即使改为 `[]`，命令行与配置文件中的数组也会被合并。现已移除该参数，改由运行时不注册默认处理程序；`isolated-profile` 测试把 `--config.protocols=null` 作为反例，确认 schema 会拒绝它。

### 3.4 真实二进制门禁 `apps/daemon/test/integration/gateway-runtime-protocol.test.ts`

这组测试用 staged 的真实 Codex 二进制跑 16 个网关场景：流式、工具往返、Chat 桥、重试边界、登出等。

| 运行 | 结果 |
| --- | --- |
| 基线 0.149.0（原夹具） | 16/16 通过 |
| 0.166.0（原夹具） | 14/16，2 个失败：custom 工具（`apply_patch`）经 Chat 桥的往返，期望写入的文件不存在 |
| 根因定位 | 夹具使用模型 `gpt-5.2`，0.166.0 已从内置目录移除该模型。对未知模型 Codex 使用 fallback 元数据，不提供 `apply_patch`：调试输出中工具列表没有它，工具结果为 `unsupported call: apply_patch`。改用两版目录都有的 `gpt-5.5` 后，`apply_patch` 正常出现 |
| 0.166.0（夹具改为 `gpt-5.5`） | 16/16 通过 |
| 基线 0.149.0（新夹具，临时文件运行后已删除） | 16/16 通过 |

结论：Chat 桥逻辑不受影响。该变化作为行为影响记录在 DIAGNOSIS.md 第 4 节，没有跳过或禁用任何测试。

### 3.5 CLI 能力与特性键（真实 0.166.0 linux 二进制）

- `exec --help`、`exec resume --help`、`mcp --help`、`mcp add --help`、`app-server --help`：0.166.0 相对 0.149.0 只有新增内容。静态能力快照依赖的标记（`--json`、`--profile`、`--cd`、`--sandbox`、`--image`、`--skip-git-repo-check`、`Run the app server`、`generate-ts`、`generate-json-schema`、mcp 子命令、`--bearer-token-env-var`、OAuth 参数）全部存在。
- OpenCreator 传给 `--disable`/`--enable` 的 13 个特性键（hooks、plugins、apps、multi_agent、browser_use、computer_use、in_app_browser、image_generation、tool_suggest、shell_tool、unified_exec、shell_snapshot、view_image）在 0.166.0 的 `features list` 中都存在，且均为 `stable`。
- `features list` 和 `--version` 的写入行为（这一项在审查中被纠正）：
  - 在系统临时目录下的空 `CODEX_HOME` 中不写入任何文件，因为 Codex 不在临时目录下创建辅助别名。
  - 在临时目录之外的 home 中（`~/.codex` 属于这种情况），`--version` 会创建并保留 `tmp/arg0-<os>/codex-arg0*/`（`.lock` 和 `apply_patch` 等符号链接），`features list` 会留下空的 `tmp/arg0-<os>/`。两者都不创建 sqlite。
  - 图像生成路径会以 `CODEX_HOME=~/.codex` 运行这些命令，原生生图还会运行 `exec --ephemeral` 并迁移 `~/.codex` 的状态库（既有设计）。MAC_RUNBOOK 因此要求先备份 `~/.codex`，并在验收中避开图像生成。
- 源码运行检查以 `--keep` 跑完全部 9 项后，作为源的假 `~/.codex`（位于系统临时目录之外）中只有原来的 `auth.json` 和 `config.toml`，确认检查脚本不会在源 home 中运行 Codex。
- 审查发现对照脚本的 `codex --version` 去掉了 `CODEX_HOME`，会在默认的 `~/.codex/tmp/` 下留下辅助链接；现已改为临时 home。复验方法：把 `HOME` 设为系统临时目录之外的假目录，并让 `--from-codex-home` 指向其中的 `.codex`（源 home 与默认 home 是同一个目录，与 Mac 上的情形相同）。对照脚本和源码运行检查跑完后，该假 HOME 中没有任何变化。

### 3.6 版本对照（`scripts/codex-runtime-ab/codex-ab.mjs`，离线）

使用真实官方二进制（linux-x64 0.149.0 与 0.166.0）、本地 HTTPS mock 后端、假 ChatGPT 账号，并采用与 OpenCreator 相同的 `clientInfo`。

| 模式 | 0.149.0 | 0.166.0 | 工具结论 |
| --- | --- | --- | --- |
| `--mock record`（不门控） | 列出 gpt-6.1-terra；turn completed，delta=1，回复 OK | 同左 | `BOTH_OK` |
| `--mock gate`（模拟门控） | 未列出；turn failed：`404 … model 'gpt-6.1-terra' does not exist or you do not have access to it`，`codexErrorInfo: other` | 列出；completed | `VERSION_GATED` |
| `--from-codex-home <假 home>`（复用 OpenCreator 的同步函数）+ gate | 同上 | 同上 | `VERSION_GATED`；源 home 未被修改；临时 home 已删除 |
| `--from-codex-home <假 home，cli_auth_credentials_store = "keyring">` + record | 列出；completed | 同左 | `BOTH_OK`；测试 home 与 OpenCreator 的 Runtime Home 一样被改为 `file` 存储，源 home 中仍是 `keyring` |
| `--from-codex-home <API key 登录的 home>` | — | — | 在下载和启动任何二进制之前退出：`not a ChatGPT login (auth mode apikey)`；源码运行检查同样拒绝 |

审查后的其他复验：

- `--mock gate` 在打印结论后立即退出，总耗时 24 秒（修复前进程会多挂约 3 分钟，等待未清除的 180 秒计时器）。
- 凭据新鲜度判断改为与 Codex 的 `proactive_refresh_reason` 一致：access token 的 exp 可解析时只看 exp（保留 30 分钟余量），只有 exp 不可解析时才看 `last_refresh`。用 6 组假 auth.json 验证了 API key 拒绝、旧 `last_refresh` 但 token 有效时放行、30 分钟内过期时拦截等情况。
- mock 的自签证书只有 2 天有效期；缓存的证书在 1 小时内过期时会重新生成（用一张已过期的证书验证）。
- 线程工作目录改到系统临时目录下（不在任何 git 仓库中），避免 Codex 把本仓库的 AGENTS.md 加进提示。

请求记录：两个版本都发送 `body.model=gpt-6.1-terra` 和 `originator=opencreator-agent`，只有 `version`、`client_version`、UA 中的版本号不同。

### 3.7 源码运行（`scripts/codex-runtime-ab/source-run-check.mjs --mock`）

用 `buildServer`（与 Desktop 启动的服务端相同）加 staged 的真实 0.166.0 Runtime，在全新数据目录下运行；同步流程与 `apps/daemon/src/main.ts` 相同；离线 HTTPS mock 后端。

| 检查 | 结果 | 证据 |
| --- | --- | --- |
| readiness、账号、模型列表 | 通过 | readiness `ready`；版本 `0.166.0`，commit `6ff1e1ca…`（来自共享常量）；ChatGPT plus 已登录，Codex 报告的账户类型为 `chatgpt`；`gpt-6.1-terra` 在 Codex 的完整模型列表和选择器列表中 |
| 对话（`/runs`，gpt-6.1-terra） | 通过 | succeeded，最终回复 `OK` |
| Creator Agent 流式输出 | 通过 | SSE 订阅者收到 `item/agentMessage/delta`；时间线中助手回复为 `OK` |
| 同线程续聊 | 通过 | mock 只在请求包含上一轮内容时回复 `OK`，实际回复 `OK` |
| daemon 重启后读取会话历史 | 通过 | 重建服务端后 `GET /threads/:id/history` 返回 200，包含第一轮的用户消息和助手回复 `OK` |
| daemon 重启后恢复线程 | 通过 | 关闭后重建服务端，继续同一线程，上下文保留 |
| 命令审批往返（`gpt-5.5`，exec_command 提权） | 通过 | 审批类型 `command_execution`，请求的命令为 `/bin/bash -lc 'touch approved.txt'`，与预期一致才批准（其他命令会被拒绝）；批准返回 HTTP 200，命令实际执行（文件已创建），run succeeded |
| 取消流式运行 | 通过 | 取消返回 HTTP 202，run `canceled`，`terminationReason: user_canceled`，耗时约 0.2 s |
| 短字幕翻译（Krillin 文本网关，与 server.ts 相同构造） | 通过 | HTTP 200；时间轴保留；中文结果（mock 返回的固定译文） |

mock 记录：所有模型请求均为 `version=0.166.0`、`originator=opencreator-agent`。

`--mock --model gpt-5.5`（config 中的模型仍为 gpt-6.1-terra）：9/9 通过。gpt-5.5 在 Codex 的完整模型列表中，但不在选择器中（选择器只保留最新两个 GPT 版本族）。对话请求经 mock 记录确认只携带 `gpt-5.5`；Creator Agent 和字幕翻译按实际使用的 config 模型标注为 gpt-6.1-terra。审查前，`--model` 只改了检查项名称，对话实际仍使用 config 中的模型。

隔离：检查进程把服务商凭据文件指向独立目录中不存在的 `.env.local`，并清除 `VOLCENGINE_*` 环境变量。用临时 HOME 中的假 `~/.opencreator/.env.local` 验证：不设置时 daemon 的加载函数读到两个火山引擎键，设置后读到的为空。

说明：`/runs` 的事件日志只保存完整消息，不保存 token 级 delta（0.149.0 也是如此）。用户可见的流式输出在 Creator Agent 路径上验证。审批场景离线使用 `gpt-5.5`：0.166.0 中 `gpt-6.1-terra` 是 responses-lite / code mode，工具定义由服务端提供，离线 mock 无法模拟其工具调用。

### 3.8 全量回归（升级后的代码）

以下结果来自最终代码（包含全部审查修正）。

| 命令 | 结果 |
| --- | --- |
| `apps/daemon`: `CODEX_HOME=<临时目录> npx vitest run` | 252 个文件：243 通过、1 失败、8 跳过；2465 个测试：2420 通过、1 失败、44 跳过 |
| 副作用说明 | 该套件中有 57 处 `buildServer` 没有传 `codexHome`，会改写 `$CODEX_HOME` 或 `~/.codex/config.toml`（既有行为）。最终一轮把 `CODEX_HOME` 指向临时目录，套件只在该目录写入了 `config.toml`，`~/.codex` 没有变化，验证了 MAC_RUNBOOK.md 第 0 节的做法。更早一轮没有设置 `CODEX_HOME`，写入了容器自己的 `/root/.codex/config.toml`（会话开始时不存在，无用户数据），已删除 |
| 上述 1 个失败 | `creator-wechat-article.test.ts`：`No CJK font is available for PDF generation`。容器没有 CJK 字体（CI 会先安装 `fonts-noto-cjk`）。在基线 0.149.0 上运行同一测试，失败完全相同，与本次改动无关 |
| `apps/desktop`: `npx vitest run` | 46 个文件；340 个测试：338 通过、2 跳过、0 失败 |

### 3.9 历史读取与回滚兼容（`scripts/codex-runtime-ab/thread-history-probe.mjs`）

用两版真实 linux-x64 官方二进制、离线 mock 后端和假账号，在全新的 `CODEX_HOME` 中运行，结果为 `RESULT: PASS`：

| 探针 | 0.149.0 | 0.166.0 |
| --- | --- | --- |
| 新建线程的 `historyMode` | `legacy` | `paginated` |
| app-server 重启后直接 `thread/turns/list` | 成功（1 个 turn） | 成功（1 个 turn） |
| `thread/resume` 带 `excludeTurns: true` | 返回 0 个 turn，无弃用通知，随后 `thread/turns/list` 正常 | 同左 |
| `thread/resume` 不带 `excludeTurns` | 返回 1 个 turn，无通知 | 返回 1 个 turn，并发出 `deprecationNotice`：`Full-history hydration is deprecated for paginated threads; use excludeTurns: true, then page with thread/turns/list and thread/items/list.` |

回滚：先用 0.166.0 新建一个 paginated 线程并完成一轮，再用 0.149.0 打开同一个 home：

- `thread/list` 能列出该线程。
- `thread/turns/list` 和 `thread/read`（`includeTurns`）都返回 userMessage 和 agentMessage。
- `thread/resume` 成功，续聊一轮 completed，发给模型的请求中带有第一轮的内容。
- 之后 0.166.0 再读这个线程，能看到 2 个 turn。

范围：只覆盖简单文本对话，含工具调用、图片、压缩（compaction）的长线程未验证。

### 3.10 Web 端开发模式（离线 API 检查）

按 MAC_RUNBOOK 第 3.1 节的环境变量启动 Web 开发服务器（与 `pnpm web:dev` 相同的 vite 命令；容器中直接调用 vite，因为假 HOME 会让 pnpm 先尝试把自身安装进该 HOME）。假 `~/.codex` 的配置指向离线 mock，请求都经 Web 开发服务器的 `/.opencreator/runtime` 代理发出：

| 检查 | 结果 |
| --- | --- |
| `GET /codex/readiness` | `ready`，版本 `0.166.0`，`binaryPath` 为已准备的 `apps/desktop/.pack/codex-runtime/bin/codex` |
| `GET /codex/account` | `signed_in`，plan `plus`（从假 `~/.codex` 同步） |
| `GET /codex/models` | gpt-6.1-sol、gpt-6.1-terra、gpt-5.6-terra |
| 新建项目和线程，运行 `Reply with exactly: OK` | succeeded，回复 `OK` |
| 假 `~/.codex` | 没有变化；Codex 的状态库等只写入独立目录中的 Runtime Home |

没有做的：浏览器中的界面操作，需要真实账号，见第 5 节。

## 4. 未验证：需要在 Mac 上执行的构建与打包门禁

| 项目 | 原因 | 怎么验证 |
| --- | --- | --- |
| macOS 独立测试包（`OPENCREATOR_DESKTOP_ISOLATED_PROFILE=codex-0166 pnpm --filter @opencreator/desktop package`） | 在 Linux 上无法产出 macOS App：stickman 准备要求目标平台等于宿主平台，better-sqlite3 用宿主工具链编译，sharp 只装宿主平台依赖，iconutil、codesign、plutil 是 macOS 专有 | MAC_RUNBOOK.md 第 4 节 |
| `verify-package`（含 App 内嵌 Web 与 `apps/web/dist` 哈希比对、Fuses、codesign、体积门槛） | 同上；它在打包流程末尾自动执行 | 同上 |
| macOS 签名推断：ad-hoc `--deep` 重签不改动 `codex-runtime`；codex 保留 OpenAI Developer ID 签名 | 来自代码和 Mach-O 签名解析的推断，未在 Mac 上执行 | MAC_RUNBOOK.md 第 4 节的核对命令 |
| 隔离 profile 在真机的效果（bundle id、独立 userData 与数据根、不注册为深链默认处理程序、无更新） | 只有单元测试和编译验证；打包参数已用 electron-builder 自身的 schema 校验 | MAC_RUNBOOK.md 第 4 至 6 节 |
| 打包 App E2E（`pnpm --filter @opencreator/desktop e2e:package:smoke`，24 个用例，其中 5 个以 bundled 模式启动包内真实的 0.166.0） | 需要实际包；假 Codex 夹具版本已同步为 0.166.0 | MAC_RUNBOOK.md 第 4.1 节。只对隔离 profile 包运行：非隔离构建每次启动都会把自己注册为 `opencreator://` 的默认处理程序 |
| Web 端同流程检查（`pnpm web:dev` 使用已准备的 0.166.0） | 需要真实账号和浏览器操作；API 层已离线验证（第 3.10 节） | MAC_RUNBOOK.md 第 3.1 节 |
| Linux 打包 | Linux 不在官方发布矩阵中；容器网络阻断 Electron headers 和 Chromium headless shell 的下载 | 不在本次范围 |
| Windows 打包，以及 Codex 512 MiB 和整包 1600 MiB 门槛的余量 | 无 Windows 环境 | Windows 发布前执行 |

## 5. 未验证：需要真实 ChatGPT 账号的验收（请在 Mac 上回填）

| 项目 | 命令或步骤 | 状态 | 实际结果 |
| --- | --- | --- | --- |
| 同账号对照，结论应为 `VERSION_GATED` | `node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex` | 未验证 | |
| 源码运行 9 项（真实模型） | `node --import tsx scripts/codex-runtime-ab/source-run-check.mjs --from-codex-home ~/.codex` | 未验证 | |
| Web 端同流程（第 5 节第 1 至 5 项） | MAC_RUNBOOK.md 第 3.1 节 | 未验证 | |
| 打包 App 冒烟 E2E | MAC_RUNBOOK.md 第 4.1 节 | 未验证 | |
| 真实模型响应（gpt-6.1-terra） | MAC_RUNBOOK.md 第 5 节第 1 项 | 未验证 | |
| 流式输出 | 第 5 节第 2 项 | 未验证 | |
| 工具与审批（gpt-6.1-terra 的 code mode 工具） | 第 5 节第 3 项 | 未验证 | |
| 取消 | 第 5 节第 4 项 | 未验证 | |
| 恢复（App 重启后续聊；Creator 刷新后无重复 Activity） | 第 5 节第 5 项 | 未验证 | |
| 短字幕翻译（句数和时间轴完整，无 `partial_answer` 截断，无积分提示） | 第 5 节第 6 项 | 未验证 | |
| 正式数据未变 | MAC_RUNBOOK.md 第 6 节 | 未验证 | |

### 5.1 为什么不用仓库现有的真实 Codex smoke 作为验收

- `apps/daemon/test/smoke/real-codex-smoke.test.ts` 执行的是 PATH 上的 `codex`，而不是内置 Runtime。它使用 `~/.codex`，会在全局 Codex home 中安装后删除 skill，也不覆盖审批、中断和字幕翻译。
- `apps/desktop/e2e/real-codex.smoke.ts` 的用例一已经过时：它期望使用 `/Applications/Codex.app` 中的二进制。用例二不隔离 `OPENCREATOR_HOME`，并且断言付费官方网关的探测结果为成功，与“不使用积分”的约束冲突。
- 因此改用 `scripts/codex-runtime-ab/source-run-check.mjs`：它使用内置 Runtime、独立数据目录、只读同步 `~/.codex`，覆盖上述全部场景。

## 6. 残余风险

1. 根因判断来自目录元数据、客户端源码和离线对照。服务端到底依据哪个信号门控（`client_version`、`version` 头、UA 或 originator），以及该账号或工作区是否有权限，只有真实对照能确认。如果对照结论是 `ACCOUNT_OR_MODEL_AVAILABILITY`，本次升级不能解决问题。
2. 0.149.0 → 0.166.0 跨度为 3256 个提交，0.166.0 发布只有 4 天。本报告覆盖了 OpenCreator 实际使用的协议面和路径，但真实模型在 code mode 下的工具行为、`partial_answer` 拆分、`deprecationNotice` 的出现频率，以及 0.166.0 新默认开启的特性（如 `instant_interrupt`、`system_proxy_fallback`、`plugin_discovery_prefetch`，见 DIAGNOSIS.md 第 4 节）在真实环境中的表现，都尚未验证。
3. 模型选择器沿用“只保留最新两个 GPT 版本族”的既有规则，升级后 gpt-5.6 和 gpt-5.5 不再出现在选择器里（按内置目录模拟，远端目录未验证）。
4. 网关路径下，内置目录外的模型使用 fallback 元数据，没有 `apply_patch`。0.166.0 移除了 gpt-5.2、gpt-5.4、gpt-5.4-mini。
5. 回滚到 0.149.0 时，0.166.0 原地迁移过的状态库能打开。离线探针中，0.149.0 能列出、读取并续聊 0.166.0 新建的 paginated 线程（第 3.9 节），但只覆盖简单文本对话。正式升级前仍请先备份（ROLLBACK.md 第 3 节）。
