# 诊断：OpenCreator 3.2.9 内置 Codex 0.149.0 调用 gpt-6.1-terra 报 model_not_found

> 日期：2026-11-02
> 分支：`claude/funny-gauss-fclzeh`
> 基线：OpenCreator Desktop 3.2.9，内置 Codex `0.149.0`（`rust-v0.149.0` / `758ef40f50c1a458425c7cfbf1eb12cbc07af0b0`）
> 候选：Codex `0.166.0`（`rust-v0.166.0` / `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856`，npm `latest`，2026-10-29 发布）

## 0. 执行环境与边界（先读）

- 本次工作在 Claude Code 云端 Linux 容器（x86_64）中完成，**没有接触你的 Mac**：Remote Control 中没有可连接的 Mac 文件夹，容器里也没有你的 `~/.codex`、`auth.json` 或 OpenCreator 数据。
- 容器网络策略阻断 `chatgpt.com`，因此**没有用任何真实账号发出过模型请求**。所有“真实模型”相关结论都标为“未验证”，需要在 Mac 上用第 5 节的命令确认。
- 任务说明里提到的 `OpenCreator_Codex_Upgrade_ClaudeCode.md` 在仓库和容器中都不存在（全盘查找无结果），本次按你消息中的执行顺序和边界执行。
- 未读取、打印或上传任何真实密钥、token、`auth.json`、完整配置或环境变量。离线实验使用的是脚本现场生成的假 JWT 和本地自签证书。

## 1. 结论

**根因（高置信度推断，等待真实账号对照确认）：服务端按客户端版本对 `gpt-6.1-terra` 做门控，而 OpenCreator 3.2.9 内置的 Codex 0.149.0 低于该模型要求的最低客户端版本。**

1. 官方 Codex 模型目录里，`gpt-6.1-terra` 的 `minimal_client_version` 是 `0.153.0`，最早出现在 `rust-v0.165.0` 的目录中。`0.149.0` 的目录里完全没有 gpt-6.x。
2. Codex 客户端在每个请求里都声明自己的版本：`GET /models?client_version=0.149.0`，所有请求带 `version: 0.149.0` 头，User-Agent 为 `opencreator-agent/0.149.0 …`。两个版本的客户端源码都不读取 `minimal_client_version`，门控只可能发生在服务端。
3. 同配置、同（模拟）账号、同模型的离线对照中，0.149.0 和 0.166.0 都把 `model: gpt-6.1-terra` 原样发给服务端，请求之间唯一的差异就是版本号。客户端本身并不拦截这个模型。
4. （推断，未在你的 Mac 上验证）`gpt-6.1-terra` 的模型名很可能来自 `~/.codex/config.toml`：OpenCreator 每次启动都把用户全局 Codex home 的 `auth.json` 和 `model` 等配置同步进自己的隔离 Runtime Home，所以较新的官方 Codex App/CLI 写入的 `model = "gpt-6.1-terra"` 会被内置的 0.149.0 使用。其他可能来源见第 2.4 节。
5. 该模型的 `available_in_plans` 覆盖 free、go、plus、pro、team、business、edu、enterprise 等几乎所有套餐，所以“套餐不支持”的可能性低，但不能排除工作区策略或灰度。

**修复：把内置 Codex 固定到已校验来源的稳定版 0.166.0。** 不修改认证、套餐或服务端权限逻辑，不改用户配置，不切换付费 API，不降级模型。

**代码中没有自动付费回退**（第 2.6 节有代码证据），这一点与本次故障无关，但已确认。

## 2. 证据链

### 2.1 官方模型目录按 tag 二分（`codex-rs/models-manager/models.json`）

| Codex tag | 目录中的 gpt-6.x | gpt-6.1-terra |
| --- | --- | --- |
| rust-v0.149.0 ~ rust-v0.153.0 | 无 | 无 |
| rust-v0.153.1 ~ rust-v0.156.0 | gpt-6-astra | 无 |
| rust-v0.156.1 ~ rust-v0.159.0 | + gpt-6-sol、gpt-6-luna | 无 |
| rust-v0.159.1 ~ rust-v0.164.0 | + gpt-6.1-sol | 无 |
| **rust-v0.165.0、rust-v0.166.0** | + **gpt-6.1-terra** | `minimal_client_version: 0.153.0`、`visibility: list` |

补充：
- 0.149.0 目录：gpt-5.6-sol/terra/luna、gpt-5.5、gpt-5.2，以及隐藏的 gpt-5.4、gpt-5.4-mini、codex-auto-review。
- 0.166.0 目录：gpt-6.1-sol（priority 1）、gpt-6-astra、gpt-6-sol、gpt-6-luna、gpt-5.6-*、gpt-6.1-terra、gpt-5.5 等。**gpt-5.2、gpt-5.4、gpt-5.4-mini 已从内置目录移除。**
- 版本时间线：0.149.0（2026-08-20）、0.153.0（2026-09-03）、0.165.0（2026-10-27）、0.166.0（2026-10-29）。两个 tag 之间有 3256 个提交。

### 2.2 客户端如何向服务端声明版本（两个 tag 的源码）

| 位置 | 行为 |
| --- | --- |
| `codex-rs/codex-api/src/endpoint/models.rs` | `GET {base}/models` 追加 `?client_version=<主.次.补丁>` |
| `codex-rs/model-provider-info/src/lib.rs`（`create_openai_provider`） | 内置 OpenAI provider 给所有请求加 `version: <CARGO_PKG_VERSION>` 头 |
| `codex-rs/login/src/auth/default_client.rs` | `originator` 头与 User-Agent `<originator>/<版本> …`；originator 来自 app-server `initialize` 的 `clientInfo.name`，OpenCreator 为 `opencreator-agent` |
| `codex-rs/models-manager/src/*`、`protocol/src/openai_models.rs` | 两个版本都不读取 `minimal_client_version`，客户端没有门控 |

### 2.3 离线对照实验（真实官方二进制 + 本地 HTTPS mock 后端）

二进制来源：npm `@openai/codex@0.149.0-linux-x64`、`@openai/codex@0.166.0-linux-x64`，sha512 与 registry 及仓库 manifest 一致。

**A. record 模式**（mock 不做任何门控，只记录请求）：两个版本使用同一个配置生成脚本、同一个假 ChatGPT 账号、同一模型、同一提示，并走 `app-server` 与 OpenCreator 相同的 `clientInfo`。

| 观测项 | 0.149.0 | 0.166.0 |
| --- | --- | --- |
| `GET /codex/models` 的 `client_version` | `0.149.0` | `0.166.0` |
| `POST /codex/responses` 的 `body.model` | `gpt-6.1-terra` | `gpt-6.1-terra` |
| `version` 头 | `0.149.0` | `0.166.0` |
| `x-codex-routing-hint` | `model=gpt-6.1-terra` | `model=gpt-6.1-terra` |
| `originator` | `opencreator-agent` | `opencreator-agent` |
| `model/list` 是否包含 gpt-6.1-terra（服务端提供时） | 是 | 是 |
| turn 结果 | completed，流式 delta=1，回复 `OK` | completed，流式 delta=1，回复 `OK` |

结论：只要服务端放行，两个版本都能使用 gpt-6.1-terra。用户看到的 model_not_found 只能来自服务端，而请求间唯一随版本变化的就是版本标识。

**B. 兼容性补充**：把 0.166.0 的完整官方目录作为服务端响应喂给 0.149.0，0.149.0 能正常解析并写入缓存，不存在“旧客户端解析不了新模型元数据”的问题。

**C. gate 模拟**（mock 人为实现“版本低于 minimal_client_version 就拒绝”，**这是模拟，不是服务端行为的证据**，只用来复现错误形态）：
- 0.149.0：`model/list` 中没有 gpt-6.1-terra；turn 失败，报 `unexpected status 404 Not Found: The model 'gpt-6.1-terra' does not exist or you do not have access to it.`，`codexErrorInfo: "other"`，与用户症状一致。
- 0.166.0：同一门控下正常完成。工具结论为 `VERSION_GATED`。

**D. 诊断特征**：0.149.0 使用目录外的模型时会记录 `Unknown model gpt-6.1-terra is used. This will use fallback model metadata.`，并发出警告 `Model metadata for 'gpt-6.1-terra' not found. Defaulting to fallback metadata`（OpenCreator 记为 `CODEX_WARNING`）。在 Mac 的 OpenCreator 日志或 run 事件里看到这条警告，就说明实际使用的模型在 0.149.0 的目录之外。

### 2.4 OpenCreator 里 gpt-6.1-terra 从哪里来

- Desktop 启动 daemon 时传入 `OPENCREATOR_LOCAL_CODEX_HOME = $CODEX_HOME 或 ~/.codex`（`apps/desktop/src/main/daemon-manager.ts:326-328`）。
- daemon 启动时执行 `synchronizeLocalCodexConfiguration(localCodexHome, codexHome)`（`apps/daemon/src/main.ts:88-99`），把 `auth.json` 和最小配置复制进隔离 home。最小配置的键为 `model`、`model_provider`、`model_catalog_json`、`openai_base_url`、`chatgpt_base_url`、`cli_auth_credentials_store`、`forced_login_method`、`forced_chatgpt_workspace_id`、`service_tier` 等，见 `apps/daemon/src/codex/probe-home.ts:24-36,94-116`。
  - 涉及的目录有 `~/.opencreator/runtime/codex`、`runtime/creator-text-codex`（Krillin 字幕翻译）和 `runtime/creator-codex`。
  - 这就是“继续使用自己的 ChatGPT 登录”的实现方式。
- 普通对话（Composer 未选模型时）、Creator Agent 和 Krillin 字幕翻译都向 Codex 发送 `model: null`（`apps/daemon/src/codex/app-server-host-2026-07-28.ts:436,446,506`；`creator/agent/agent-service.ts:314-318`；`creator/krillin/codex-llm-gateway.ts:201-213`）。这时 Codex 使用 config.toml 中的 `model`，也就是从 `~/.codex` 同步来的值。
- 最可能的机制：你本机较新的官方 Codex（≥0.165）把 `model = "gpt-6.1-terra"` 写进了 `~/.codex/config.toml`，OpenCreator 原样同步。界面上显示的却是目录默认模型（如 gpt-5.6-sol），掩盖了实际使用的模型。
- 次要可能（未排除）：localStorage 的 `opencreator.models.recent-config.v1`、项目或线程中持久化了 `gpt-6.1-terra`；或 `~/.codex` 中的 `model_catalog_json`（会被同步）。`~/.codex` 里的 profile 不会生效，因为同步不复制 `profile` 和 `[profiles.*]`。

### 2.5 为什么界面上表现为“连接中断”或 `codex_completion_failed`

- 0.149.0 没有 model_not_found 分类。SSE `response.failed` 带未知 code 会被当作可重试，最多重连 5 次，并可能从 WebSocket 回退到 HTTPS。OpenCreator 因此先显示“连接中断，正在自动重连(n/5)”，最后显示 `CODEX_STREAM_ERROR`。
- Creator Agent 失败后会复查配置，可能提示“配置已同步，请重新发送”（`creator_codex_config_resynced`），误导用户以为是配置问题。
- Krillin 文本网关丢弃原因，只返回 `codex_completion_failed`。
- 0.166.0 把 `model_not_found` 解析为不可重试的 `codexErrorInfo: "modelNotFound"`。OpenCreator 目前不读取这个字段，界面仍显示原文，这不影响本次修复。

### 2.6 不会自动切换到付费 API 或积分（代码证据）

- `manual`（本机登录）来源只走 manual runtime，出错不回退到官方 manager（`apps/daemon/src/gateway/runtime-source.ts:5-28`）。
- 切换到积分网关必须显式调用 `PATCH /gateway/source`，且需要已登录（`apps/daemon/src/gateway/account-service.ts:798-803`）；Web 只调用 `setSource('manual')`。
- Krillin 的 `llm_fallback` 只在存在官方 binding 时写入（`apps/daemon/src/creator/krillin/cli-runner.ts:146-163`）。
- Codex 的 `allow_provider_model_fallback` 默认关闭；Creator 失败后只重新同步本地配置，不换模型。

## 3. 版本选择：为什么是 0.166.0

- 它是对照通过的候选版本，也是 npm `latest` 和 GitHub 上的稳定发布（非 alpha）。
- 它很新：2026-10-29 发布，距本次工作只有 4 天；gpt-6.1-terra 最早进入内置目录的是 0.165.0（2026-10-27）。因此 Mac 上的真实验收是必要的兜底。如果实测发现 0.166.0 特有的回归，可以改用 0.165.0，按同样的流程重新做对照、逐文件哈希和协议快照（不换模型）。
- 只有 0.165.0 及以上的内置目录带 gpt-6.1-terra 的完整元数据。例如 0.153.x 虽能通过服务端版本门槛，但会对 gpt-6.1-terra 使用 fallback 元数据，而 fallback 元数据没有 `apply_patch` 等工具（见第 4 节的网关测试现象）。
- **来源双重校验**：npm 包的 sha512 与 registry 一致，0.149.0 的值也与仓库现有 manifest 一致。下载 GitHub 官方发布资产（`codex-package-*.tar.gz` / `codex-x86_64-pc-windows-msvc.exe.zip`）后比对：
  - darwin-arm64、darwin-x64、linux-x64 逐文件比对（40、40、42 个文件）**逐字节一致**，差异只有 `codex-package.json`，以及 GitHub 包多出的 `codex-exec-server`（OpenCreator 不使用）。
  - Windows 的 GitHub zip 目录结构不同，只比对了 `codex`、`codex-code-mode-host`、`codex-command-runner`、`codex-windows-sandbox-setup` 四个二进制，均一致。voice 的 `manifest.json` 中可执行文件路径写法不同（voice 不收录）。
- 打包分析报告：0.166.0 两个 darwin 包中的全部 Mach-O 均由 `Developer ID Application: OpenAI OpCo, LLC (2DC432GLL2)` 签名，带时间戳和 hardened runtime。OpenCreator 的 macOS 签名流程不重签 `codex-runtime`，所以无需改动。

## 4. 升级的行为影响（已核实）

| 变化 | 影响与处理 |
| --- | --- |
| 上游不再提供 `codex-resources/zsh/bin/zsh`（zsh-fork 后端已删除） | 从三个 manifest 移除该条目；OpenCreator 代码不引用 zsh |
| 上游新增 `codex-resources/voice/**`（语音宿主与 gstreamer 库，README 写明未接入 CLI/TUI） | 不收录，避免增大体积和 LGPL 分发义务；文本 Agent 不需要 |
| app-server 协议 | 基本向后兼容。0.149.0 的方法、通知和服务端请求中，只有 `thread/rollback` 被移除（只剩 `thread/revert`），OpenCreator 源码不调用它；其余全部保留，已有消息只增加字段或可选字段，另新增约 40 个方法或通知名。OpenCreator 的现有调用不需要改动 |
| 新线程默认 `historyMode=paginated` | 实测 0.166.0 新建线程为 `paginated`，0.149.0 为 `legacy`。运行时读取路径（`thread/turns/list`、`thread/search`）原生支持。会话历史有一个回退分支：`thread/turns/list` 报 `thread not loaded` 时先 `thread/resume`。这一步原先请求全量轮次，0.166.0 会对 paginated 线程发出弃用通知并全量加载历史，而这个响应本来就被丢弃，因此补上 `excludeTurns: true`（两版二进制实测都接受，见 TEST_REPORT 3.9）。实测中两版在重启后都能直接分页读取已持久化的线程，这个分支很少触发。回滚兼容性见 ROLLBACK.md 3.3 |
| `MessagePhase` 新增 `partial_answer` | Codex 自己的“最后一条助手消息”同样逐条覆盖、不拼接，OpenCreator 取最后一条与上游语义一致，未改动；真实 gpt-6.1-terra 是否拆分答案：**未验证**（短字幕翻译验收覆盖） |
| `deprecationNotice`（对 paginated 线程 `thread/read includeTurns`） | 只出现在普通对话：在新的 app-server 进程中继续已有线程时，runtime manager 会先调用 `thread/read includeTurns`（`app-server-runtime-manager.ts:140-141`）。Creator 适配器传 `readThreadBeforeResume:false`，不走这条路径。这条通知不带 threadId，OpenCreator 把它记为一条 `unknown_event` 运行事件，Web 时间线不渲染它，也不进入会话消息和 Activity |
| 命令审批新增 `kind: command｜writeStdin` | 服务端对 accept/decline 的映射不变；源码运行中审批往返通过 |
| 默认开启的特性 | 按两版 `codex-rs/features` 的特性表计算：0.166.0 新增 23 个默认开启的特性（另有 2 个已处于 Removed 阶段），`personality` 和 `remote_compaction_v2` 改为默认关闭。OpenCreator 只在内置工具隔离运行时追加 `--enable/--disable`，普通对话沿用 Codex 的默认值。真实环境中需要留意：`instant_interrupt`（仍在开发中但默认开启，影响追加指令和取消）、`write_stdin_approval` 与 `unified_exec_tty`（可能出现 `writeStdin` 类审批）、`system_proxy_fallback`（回退到 macOS 系统代理）、`plugin_discovery_prefetch`（app-server 启动时联网预取）、`sleep_tool`（不在 OpenCreator 的禁用清单中）。本次不改这些默认值 |
| Account 新增 `gcp` 类型 | 原逻辑会误标为 `amazon_bedrock`，改为穷举映射（与 ChatGPT 登录无关） |
| 内置目录移除 gpt-5.2、gpt-5.4、gpt-5.4-mini | 网关路径若选择这些模型，会退化为 fallback 元数据（没有 `apply_patch`）；默认网关模型 gpt-6.1-sol 反而从“未知”变为“已知” |
| 模型选择器只保留最新两个 GPT 版本族（原有规则） | 升级后显示 6.1 与 6 两族，5.6、5.5 不再出现在选择器中（按内置目录模拟，远端目录未验证） |
| Windows Codex Runtime 体积 461 MiB | 超过原 450 MiB 门槛，Windows 门槛调到 512 MiB；macOS（326/350 MiB）和 Linux（385 MiB）仍为 450 MiB |
| 0.149.0 写入的 `models_cache.json` | 0.166.0 因 `client_version` 不符且缺少 identity 字段，自动视为未命中，无需删除 |
| 图像生成以 `CODEX_HOME=~/.codex` 运行内置 Codex（3.2.9 已有设计） | 升级后由 0.166.0 执行：状态检查在 `~/.codex/tmp/arg0-*` 留下辅助链接，原生生图会把 `~/.codex` 的状态库迁移到 0.166.0 结构。本次未改动，验收时避开；见 MAC_RUNBOOK 第 5 节和 ROLLBACK 第 1 节 |

## 5. 必须在 Mac 上用真实账号确认的部分

运行（只读使用 `~/.codex`，在临时目录中进行，不打印凭据）：

```bash
node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home ~/.codex
```

可加 `--old-bin /Applications/OpenCreator.app/Contents/Resources/codex-runtime/bin/codex`，直接用正式安装里的 0.149.0 二进制作为基线。

| 工具结论 | 含义 | 下一步 |
| --- | --- | --- |
| `VERSION_GATED` | 0.149.0 报 model_not_found，0.166.0 成功 | 确认根因，按 MAC_RUNBOOK 第 3 步起继续验收，并把结果回填到 TEST_REPORT.md 第 5 节 |
| `ACCOUNT_OR_MODEL_AVAILABILITY` | 两个版本都报 model_not_found | **不要归因于版本**。检查该账号或工作区是否有 gpt-6.1-terra 权限（官方 Codex App 能否选中该模型）、`forced_chatgpt_workspace_id`、`service_tier`；必要时用 `--login` 重新登录对照 |
| `BOTH_OK` | 两个版本都成功 | 原故障不是版本门控。检查 OpenCreator 实际发送的模型（localStorage recent-config、线程或项目中保存的模型） |
| `CANDIDATE_FAILED` | 0.166.0 因其他原因失败 | 先排查认证、网络或代理（`CODEX_CA_CERTIFICATE`）、配置，再决定是否继续 |
| `INCONCLUSIVE` | 结果不属于以上情况，例如 0.149.0 失败但错误文字不像 model_not_found | 查看 `report.json` 中两个版本的 `error` 和 `stderrTail` 再判断，不要直接继续 |
| `NO_CHATGPT_LOGIN` | Codex 没有报告 ChatGPT 登录，脚本没有发出任何 turn | 用自己的 ChatGPT 账号登录后重跑（keyring 用户见 MAC_RUNBOOK 第 2.1 节） |

## 6. 最小补丁清单

| 文件 | 改动 |
| --- | --- |
| `resources/codex-runtime/{darwin-arm64,darwin-x64,linux-x64,win32-x64}/manifest.json` | 0.166.0 的 tag/commit/URL/sha512/逐文件 sha256；协议改为 `v0_166_0`；移除 zsh |
| `apps/desktop/scripts/codex-runtime-contract.mjs` | 版本常量；协议 `sourceTag` 改由常量推导（原为独立字面量） |
| `apps/desktop/scripts/prepare-codex-runtime.mjs` | 默认协议目录由 manifest 的 `appServerProtocol.sourceVersion` 推导，并校验格式 |
| `apps/desktop/src/main/codex-resolver.ts`、`apps/daemon/src/codex/capabilities.ts` | 版本和 commit 常量 |
| `apps/daemon/src/api/server.ts` | readiness 中硬编码的旧 commit 改用共享常量（原先没有测试覆盖） |
| `apps/daemon/scripts/generate-codex-app-server-protocol.mjs` | 默认 tag 和 commit 改为 0.166.0；默认输出目录和头注释跟随 `--tag`（原先头注释写死为 0.149.0）。非默认 tag 需同时传 `--expected-commit`。修复后用 `--tag rust-v0.149.0 --expected-commit 758ef40f…` 重新生成，仍与原快照逐字节一致 |
| `apps/daemon/src/codex/generated/v0_166_0/`（替换 `v0_149_0/`） | 用修复后的生成器从官方 tag 生成，206 个文件，聚合哈希 `095d2414c3c711d94f67ec85a095ec2be313e5eed855ad7a60cb7adac51c9521` |
| `apps/daemon/src/codex/{runtime-readiness,provider-config}.ts` | 协议导入路径；`gcp` 账户的穷举映射 |
| `apps/daemon/src/codex/sessions/app-server-provider.ts` | 会话历史回退分支中的 `thread/resume` 加 `excludeTurns: true`（见第 4 节） |
| `apps/desktop/scripts/verify-package.mjs` | Windows Codex Runtime 体积门槛 512 MiB |
| 测试与夹具 | 协议快照测试改名为 0_166_0；capabilities、resolver、package 和会话历史 provider 测试；desktop e2e 假 Codex 版本；网关真实二进制门禁的夹具模型改为两版目录都有的 gpt-5.5（原 gpt-5.2 已被 0.166.0 移除）；新增 manifest/协议一致性测试和账户映射测试 |

独立测试包所需（单独提交，可单独回退）：`apps/desktop/scripts/isolated-profile.mjs`、`package-release.mjs`、`src/main/{main,runtime-profile}.ts` 及测试，详见 TEST_REPORT.md。

诊断与验收工具（单独提交）：`scripts/codex-runtime-ab/`。其中 `codex-ab.mjs` 做版本对照，`source-run-check.mjs` 做源码运行的 9 项检查，`thread-history-probe.mjs` 用两版二进制检查历史读取和回滚兼容，`mock-backend.mjs` 是离线 HTTPS mock 后端。

## 7. 建议的后续（本次未实施，非修复所必需）

- 识别 `codexErrorInfo: "modelNotFound"`，给出“当前内置 Codex 不支持模型 X”的专门提示，并停止“正在重连”和“配置已同步”这类误导文案。
- 在设置页或 Composer 中显示实际生效的模型（`GET /codex/provider` 的 model），避免界面显示与实际不符。
- Krillin 文本网关把 Codex 的错误原因透传给字幕任务。
- 未来模型的最低客户端版本会继续上调。OpenCreator 同步 `~/.codex` 的 `model` 时，如果该模型不在内置目录中，可以在 readiness 中提示（不自动换模型）。
