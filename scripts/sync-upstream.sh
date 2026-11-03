#!/usr/bin/env bash
# scripts/sync-upstream.sh
# 同步上游 krillinai/OpenCreator 到当前分支，并验证本 fork 的 Codex Runtime 补丁。
#
# 规则（与 docs/codex-upgrade-0.166.0/ 一致）：
#   1. 工作区必须干净（允许未跟踪文件），否则不合并。
#   2. 只用 merge，不用 rebase。冲突时停下，打印冲突文件和处理建议，不自动解决。
#   3. 合并前先分类上游对 Codex 的改动：NONE / CODEX_CODE_CHANGED / UPSTREAM_CODEX_BUMP。
#   4. 所有验证把 CODEX_HOME 指到临时目录，绝不碰 ~/.codex；不跑 daemon 全量套件。
#   5. 真实账号对照（--ab）和打包（--package）默认不跑，需要显式开启。
#   6. 脚本不 push、不打 tag，这两步留给人工决定。
#
# 用法：scripts/sync-upstream.sh [--no-merge] [--skip-install] [--skip-tests] [--skip-gateway]
#                                [--ab] [--package] [--upstream-branch=master] [--upstream-url=URL]
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

UPSTREAM_REMOTE="upstream"
UPSTREAM_URL="https://github.com/krillinai/OpenCreator.git"
UPSTREAM_BRANCH="master"
DO_MERGE=1; DO_INSTALL=1; DO_TESTS=1; DO_GATEWAY=1; DO_AB=0; DO_PACKAGE=0

usage() { sed -n '2,15p' "${BASH_SOURCE[0]}"; }
for arg in "$@"; do
  case "$arg" in
    --no-merge) DO_MERGE=0 ;;
    --skip-install) DO_INSTALL=0 ;;
    --skip-tests) DO_TESTS=0 ;;
    --skip-gateway) DO_GATEWAY=0 ;;
    --ab) DO_AB=1 ;;
    --package) DO_PACKAGE=1 ;;
    --upstream-branch=*) UPSTREAM_BRANCH="${arg#*=}" ;;
    --upstream-url=*) UPSTREAM_URL="${arg#*=}" ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown option: $arg" >&2; usage; exit 64 ;;
  esac
done

LOG_DIR="$REPO_ROOT/.tmp/sync-upstream"
mkdir -p "$LOG_DIR"
LOG="$LOG_DIR/sync-$(date +%Y%m%d-%H%M%S).log"
exec > >(tee -a "$LOG") 2>&1

# 规则 4：验证期间的 CODEX_HOME 是一次性临时目录，退出时删除。
export CODEX_HOME
CODEX_HOME="$(mktemp -d "${TMPDIR:-/tmp}/opencreator-sync-codex-home.XXXXXX")"
unset OPENCREATOR_CODEX_BIN OPENCREATOR_HOME OPENCREATOR_ENV_FILE CODEX_SQLITE_HOME 2>/dev/null || true
trap 'rm -rf "$CODEX_HOME"' EXIT

RESULTS=()
FAILED=0
say() { printf '\n==> %s\n' "$*"; }
record() { RESULTS+=("$1 | $2"); [ "$1" = "FAIL" ] && FAILED=1 || true; }
run_step() { # run_step <名称> <命令...>：失败不中断，记录结果
  local name="$1"; shift
  say "$name"
  if "$@"; then record PASS "$name"; else record FAIL "$name"; fi
}
manifest_version() { node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(0,"utf8")).version)'; }

# ---------- 1. 预检 ----------
say "预检：仓库状态"
git rev-parse --is-inside-work-tree >/dev/null
BRANCH="$(git branch --show-current)"
[ -n "$BRANCH" ] || { echo "处于分离 HEAD，先切到分支"; exit 1; }
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "工作区有未提交改动，先提交或 stash（规则 1）："; git status --short --untracked-files=no; exit 1
fi
HEAD_BEFORE="$(git rev-parse --short HEAD)"
echo "分支 $BRANCH @ ${HEAD_BEFORE}；日志 ${LOG}；临时 CODEX_HOME=$CODEX_HOME"

# ---------- 2. 上游远程 ----------
say "上游远程"
if ! git remote get-url "$UPSTREAM_REMOTE" >/dev/null 2>&1; then
  git remote add "$UPSTREAM_REMOTE" "$UPSTREAM_URL"; echo "已添加远程 $UPSTREAM_REMOTE -> $UPSTREAM_URL"
elif [ "$(git remote get-url "$UPSTREAM_REMOTE")" != "$UPSTREAM_URL" ]; then
  echo "注意：远程 $UPSTREAM_REMOTE 指向 $(git remote get-url "$UPSTREAM_REMOTE")，与预期 $UPSTREAM_URL 不同，按现有配置继续"
fi
git fetch --quiet "$UPSTREAM_REMOTE" "$UPSTREAM_BRANCH"
UP="$UPSTREAM_REMOTE/$UPSTREAM_BRANCH"
BEHIND="$(git rev-list --count "HEAD..$UP")"
AHEAD="$(git rev-list --count "$UP..HEAD")"
echo "上游 $UP @ $(git rev-parse --short "$UP")（$(git log -1 --format=%s "$UP")）"
echo "本分支落后 $BEHIND 个提交，领先 $AHEAD 个提交"

# ---------- 3. 分类上游的 Codex 改动 ----------
say "分类上游对 Codex 的改动"
CODEX_PATHS=(resources/codex-runtime apps/daemon/src/codex apps/desktop/scripts/prepare-codex-runtime.mjs apps/desktop/scripts/codex-runtime-contract.mjs apps/desktop/src/main/codex-resolver.ts apps/desktop/src/main/runtime-profile.ts)
OURS_VER="$(manifest_version < resources/codex-runtime/darwin-arm64/manifest.json)"
UP_VER="$(git show "$UP:resources/codex-runtime/darwin-arm64/manifest.json" | manifest_version)"
MERGE_BASE="$(git merge-base HEAD "$UP")"
BASE_VER="$(git show "$MERGE_BASE:resources/codex-runtime/darwin-arm64/manifest.json" | manifest_version)"
CODEX_COMMITS="$(git log --oneline "HEAD..$UP" -- "${CODEX_PATHS[@]}")"
KRILLIN_COMMITS="$(git log --oneline "HEAD..$UP" -- runtime/krillinai)"
echo "内置 Codex：本分支 ${OURS_VER}，上游 ${UP_VER}，分叉点 ${BASE_VER}"
# 只看上游自己有没有换版本（上游 vs 分叉点）；本分支固定的版本本来就和上游不同。
if [ "$UP_VER" != "$BASE_VER" ]; then
  CLASS="UPSTREAM_CODEX_BUMP"
elif [ -n "$CODEX_COMMITS" ]; then
  CLASS="CODEX_CODE_CHANGED"
else
  CLASS="NONE"
fi
echo "分类：$CLASS"
[ -n "$CODEX_COMMITS" ] && { echo "上游触及 Codex 相关路径的提交："; echo "$CODEX_COMMITS"; }
case "$CLASS" in
  NONE) echo "上游没动 Codex 相关文件：合并后跑常规验证即可。" ;;
  CODEX_CODE_CHANGED) echo "上游改了 daemon/desktop 的 Codex 调用：合并后必须跑真实二进制门禁（gateway-runtime-protocol）。" ;;
  UPSTREAM_CODEX_BUMP)
    echo "上游把内置 Codex 从 ${BASE_VER} 换成了 ${UP_VER}：冲突一律取上游版本；若上游版本 >= 0.166.0，用 'git revert bdf76c80' 撤掉本 fork 的固定版本提交，"
    echo "只保留隔离 profile、对照脚本和文档；新版本未验过，合并后请加 --ab 跑同账号对照，并按 MAC_RUNBOOK 第 4、5 节重验。" ;;
esac

# ---------- 4. 合并 ----------
if [ "$DO_MERGE" = 1 ] && [ "$BEHIND" -gt 0 ]; then
  say "合并 $UP 到 $BRANCH"
  if git merge --no-edit "$UP"; then
    record PASS "合并 ${UP}（$BEHIND 个提交）"
  else
    echo
    echo "合并有冲突（规则 2：不自动解决）。冲突文件："
    git diff --name-only --diff-filter=U
    echo
    echo "处理建议："
    echo "  - resources/codex-runtime/*/manifest.json、apps/daemon/src/codex/generated/：按分类结果决定取哪边，取上游就同时 revert 本 fork 的固定版本提交。"
    echo "  - apps/daemon/src/codex/{provider-config,runtime-readiness,sessions/app-server-provider}.ts：手工合并，合完必须跑 gateway-runtime-protocol。"
    echo "  - apps/desktop/src/main/{main,runtime-profile}.ts、apps/desktop/scripts/*.mjs：保留隔离 profile 逻辑，手工合并。"
    echo "  解决后：git add -A && git commit，再执行 $0 --no-merge 做验证；放弃：git merge --abort"
    exit 2
  fi
elif [ "$BEHIND" -eq 0 ]; then
  say "已与上游同步，无需合并"
else
  say "按 --no-merge 跳过合并"
fi
HEAD_AFTER="$(git rev-parse --short HEAD)"

# ---------- 5. 验证 ----------
if [ "$DO_INSTALL" = 1 ]; then run_step "pnpm install --frozen-lockfile" pnpm install --frozen-lockfile; fi
run_step "pnpm -r typecheck" pnpm -r typecheck
if [ "$DO_TESTS" = 1 ]; then
  run_step "daemon 定向测试（CODEX_HOME=临时目录）" bash -c 'cd apps/daemon && npx vitest run \
    test/unit/codex-app-server-protocol-*.test.ts test/unit/codex-capabilities.test.ts test/unit/codex-runtime-readiness.test.ts \
    test/unit/model-catalog-*.test.ts test/unit/codex-provider-config.test.ts test/unit/codex-app-server-session-provider.test.ts \
    test/unit/persistent-app-server-executor-*.test.ts test/unit/codex-probe-home.test.ts test/unit/codex-local-provider.test.ts \
    test/integration/approval-runtime.test.ts test/integration/codex-runtime-routes.test.ts test/integration/app-server-sessions-api.test.ts'
  run_step "desktop 单元测试" bash -c 'cd apps/desktop && npx vitest run'
fi
if [ -n "$KRILLIN_COMMITS" ] && [ "$DO_TESTS" = 1 ]; then
  if command -v go >/dev/null 2>&1; then
    run_step "Krillin go test（上游改了 runtime/krillinai）" bash -c 'cd runtime/krillinai && go test ./...'
  else
    echo "上游改了 runtime/krillinai，但本机没有 go，跳过 Krillin 测试"; record SKIP "Krillin go test（无 go）"
  fi
fi
if [ "$DO_GATEWAY" = 1 ]; then
  run_step "准备内置 Codex Runtime（staging）" pnpm --filter @opencreator/desktop prepare:codex-runtime
  run_step "真实二进制门禁 gateway-runtime-protocol（CODEX_HOME=临时目录）" bash -c 'cd apps/daemon && npx vitest run test/integration/gateway-runtime-protocol.test.ts'
fi
if [ "$DO_AB" = 1 ]; then
  run_step "同账号对照 codex-ab（只读同步 ~/.codex）" node --import tsx scripts/codex-runtime-ab/codex-ab.mjs --from-codex-home "$HOME/.codex"
fi
if [ "$DO_PACKAGE" = 1 ]; then
  run_step "隔离测试包（MAC_RUNBOOK §4）" env -u CSC_LINK -u CSC_KEY_PASSWORD -u CSC_NAME -u APPLE_ID -u APPLE_APP_SPECIFIC_PASSWORD -u APPLE_TEAM_ID -u OPENCREATOR_DESKTOP_OFFICIAL_BUILD -u OPENCREATOR_SIGN_CREATOR_RUNTIME -u OPENCREATOR_NOTARIZE_MAC_APP -u OPENCREATOR_CODEX_RUNTIME_ROOT -u OPENCREATOR_HOME OPENCREATOR_DESKTOP_ISOLATED_PROFILE=codex-0166 pnpm --filter @opencreator/desktop package
fi

# ---------- 6. 汇总 ----------
say "汇总"
echo "分支 ${BRANCH}：$HEAD_BEFORE -> ${HEAD_AFTER}；上游改动分类：${CLASS}；内置 Codex 本分支 ${OURS_VER}，上游 ${UP_VER}"
for r in ${RESULTS[@]+"${RESULTS[@]}"}; do echo "  $r"; done
echo "日志：$LOG"
echo "下一步（人工）："
echo "  - 验证全部通过后：git push origin ${BRANCH}；需要发版时合到 master 并打 v<apps/desktop/package.json 版本> 标签。"
[ "$CLASS" = "UPSTREAM_CODEX_BUMP" ] && echo "  - 上游换了 Codex 版本：补跑 --ab，并按 MAC_RUNBOOK 第 4、5 节用真实账号重验。"
[ "$DO_PACKAGE" = 0 ] && echo "  - 打包与冒烟 E2E 未在本次执行（加 --package，或按 MAC_RUNBOOK 第 4 节手动）。"
exit "$FAILED"
