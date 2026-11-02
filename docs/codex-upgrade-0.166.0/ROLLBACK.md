# 回滚说明（Codex 0.149.0 → 0.166.0）

本文分三种情况：测试阶段的清理、代码回滚、以及将来把 0.166.0 带入正式安装后的回滚。测试阶段的设计目标是**正式安装和正式数据始终不受影响**。

## 1. 测试阶段（独立测试包、源码运行、版本对照）的清理

测试阶段不会改动正式安装和正式数据，所以清理只需删除测试目录：

先按 bundle id 退出测试包（不会误退出正式 App），再注销 LaunchServices 登记：

```bash
osascript -e 'quit app id "com.opencreator.desktop.isolated.codex-0166"' 2>/dev/null; /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -u "$HOME/OpenCreator-Isolated/OpenCreator Codex 0166.app" 2>/dev/null; true
```

然后删除测试包和它的独立数据：

```bash
rm -rf "$HOME/OpenCreator-Isolated" "$HOME/Library/Application Support/OpenCreator Isolated codex-0166" "$HOME/.opencreator-isolated/codex-0166" "$HOME/.opencreator-isolated/codex-0166-web" "$HOME/.opencreator-isolated/source-run"
```

在仓库工作副本中（`.tmp/` 已被 `.gitignore` 忽略）：

```bash
rm -rf .tmp/codex-ab .tmp/codex-source-run .tmp/codex-history-probe apps/desktop/.pack apps/desktop/release
```

说明：
- 测试包使用独立 bundle id，不把自己设为 `opencreator://` 的默认处理程序，也不运行更新器。它的 Info.plist 仍声明该 scheme，因为 electron-builder 不能从命令行移除。如果深链被打开到测试包（例如曾运行过未加隔离 profile 的构建），打开一次正式的 `/Applications/OpenCreator.app` 即可把 `opencreator://` 重新指回正式安装；删除测试包并注销登记后，该声明也随之消失。
- `.tmp/codex-ab` 中可能留有 `--login` 产生的测试凭据（仅在使用 `--keep-login` 时保留，文件权限 0600）。删除该目录即彻底清除。
- 对照脚本和源码运行检查只读取 `~/.codex`，它们启动的 Codex 进程都使用临时 `CODEX_HOME`（离线实测，见 TEST_REPORT 3.5）。测试包的对话、Creator 和字幕翻译也只读取它（同步到独立 Runtime Home）。**图像生成功能例外**，这是 3.2.9 已有的设计：
  - 图像能力检查以 `CODEX_HOME=~/.codex` 运行内置 Codex 的 `features list` 和 `--version`，会在 `~/.codex/tmp/arg0-*/` 留下辅助链接。
  - 使用 ChatGPT 登录的原生生图以 `codex exec --ephemeral` 运行，会打开 `~/.codex` 的状态库并迁移到 0.166.0 结构。
- 如果测试期间用到了图像生成，可以用 MAC_RUNBOOK.md 第 1 节的备份恢复 `~/.codex`。恢复前退出官方 Codex App 和测试包：

```bash
B="<MAC_RUNBOOK 第 1 节打印的备份目录>"; [ -d "$B/dot-codex" ] && mv ~/.codex ~/.codex.after-test && ditto "$B/dot-codex" ~/.codex
```

  命令先确认备份存在，否则什么都不做。如果 `ditto` 中途失败，用下面的命令删掉不完整的 `~/.codex` 并放回原目录（只有原目录存在时才执行）：

```bash
[ -d ~/.codex.after-test ] && rm -rf ~/.codex && mv ~/.codex.after-test ~/.codex
```

  恢复后会回到备份时的登录状态。如果官方 Codex 在此期间刷新过 token，可能需要重新登录。确认无误后再删除 `~/.codex.after-test` 和备份目录。

## 2. 代码回滚

本次改动是分支 `claude/funny-gauss-fclzeh` 上的三个独立代码提交，另有一个文档提交（`docs(codex): …`）和一个检查脚本的后续修正：

| 提交 | 内容 | 可单独回退 |
| --- | --- | --- |
| `build(codex): pin bundled Codex runtime to 0.166.0` | manifest、常量、协议快照、生成器修复、适配和测试 | 是（回退后恢复 0.149.0 的完整状态，包括 `generated/v0_149_0`） |
| `feat(desktop): add an isolated profile for unsigned test packages` | 独立测试包所需的打包和启动隔离 | 是（与 Codex 版本无关） |
| `test(codex): add same-account A/B and source-run checks` | `scripts/codex-runtime-ab/` 诊断和验收工具 | 是，但要先回退下面的后续修正 |
| `test(codex): keep source-run state outside the repo and tighten checks` | 检查脚本的后续修正及对应文档 | 是 |

按需回退（以实际提交号为准，可用 `git log --oneline` 查看）：

```bash
git revert <pin-0.166.0 提交号>
```

正式安装的 OpenCreator 3.2.9 不受分支内容影响，回滚不涉及重装。

## 3. 将来正式安装改用 0.166.0 后的回滚

如果之后把包含 0.166.0 的构建装成正式版，然后又需要回到 3.2.9（Codex 0.149.0），需要注意以下数据层面的事实。

### 3.1 升级前先备份（强烈建议）

退出 OpenCreator 后执行：

```bash
B="$HOME/opencreator-backup-$(date +%Y%m%d-%H%M%S)"; mkdir -p "$B" && ditto ~/.opencreator/runtime "$B/runtime" && ditto ~/.opencreator/data "$B/data" && cp -p ~/.opencreator/config.toml "$B/" 2>/dev/null; echo "$B"
```

备份内容包括 `runtime/codex`、`runtime/creator-codex`、`runtime/creator-text-codex`、`runtime/external-codex` 等全部 Runtime Home，以及 `data/app.sqlite`。

### 3.2 回滚步骤

1. 退出 OpenCreator（菜单栏托盘也要退出）。
2. 重新安装 3.2.9。
3. 用备份覆盖 `~/.opencreator/runtime`（必要时连同 `data`）。

### 3.3 不恢复备份时会发生什么（已核实与未验证）

| 项 | 事实 | 状态 |
| --- | --- | --- |
| Codex 状态库文件 | 两个版本使用相同的文件名（`state_5.sqlite`、`logs_2.sqlite`、`goals_1.sqlite`、`memories_1.sqlite`、`queue_1.sqlite`、`thread_history_1.sqlite`），0.166.0 原地迁移：state 由 50 个迁移增至 62 个，memory 增加 1 个，thread_history 增加 4 个 | 已核实（源码与实测文件名） |
| 0.149.0 打开被 0.166.0 迁移过的库 | 0.149.0 的迁移器设置了 `ignore_missing: true`，注释写明是为了让旧版能打开被新版迁移过的库 | 已核实（源码）。能否正确读取新数据：**未验证** |
| 0.166.0 新建的线程 | 默认 `historyMode=paginated`，rollout 不再写 legacy 的 `event_msg` 用户和助手消息。离线探针中，0.149.0 在同一 home 中能列出、分页读取、`thread/read` 并续聊这些线程，续聊请求带有之前的对话；之后 0.166.0 也能读到 0.149.0 追加的轮次（TEST_REPORT 3.9） | 简单文本对话已核实（离线 mock）。含工具调用、图片、压缩的长线程**未验证**，最稳妥的做法仍是恢复备份 |
| `models_cache.json` | 按 `client_version` 区分，0.166.0 还要求 identity 字段；升级和回滚两个方向都会自动视为未命中，无需删除 | 已核实（源码） |
| `auth.json` | 格式向后兼容，旧版忽略未知字段 | 已核实（源码中没有 `deny_unknown_fields`） |
| OpenCreator 写入的 `config.toml` 键 | 来自 `~/.codex` 的最小同步键和 `cli_auth_credentials_store="file"`，两个版本都接受 | 已核实 |
| `~/.codex` | 对话、Creator、字幕翻译路径只读。图像生成路径会以 `CODEX_HOME=~/.codex` 直接运行内置 Codex（`tmp/arg0-*` 辅助链接；原生生图会迁移状态库），这是 3.2.9 已有的设计 | 已核实（代码路径；在 /tmp 外的 home 中实测 `--version` 会留下 `tmp/arg0-*`） |

### 3.4 Token 轮换提示

OpenCreator 本身会把 `~/.codex/auth.json` 复制进自己的 Runtime Home。任一副本刷新 ChatGPT token 后，另一处的 refresh token 可能失效（`refresh_token_reused`），这时在官方 Codex 或 OpenCreator 中重新登录即可。这是现有同步设计固有的行为，与本次升级无关。
