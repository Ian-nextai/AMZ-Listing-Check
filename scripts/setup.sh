#!/bin/bash
# 环境自检/安装：Chromium、扩展、Node、依赖库。幂等，可重复跑。
# 用法: setup.sh [--check]   # --check 只诊断不安装
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
CHECK_ONLY=""
[ "${1:-}" = "--check" ] && CHECK_ONLY=1

PASS=0; FAIL=0; WARN=0
ok()   { echo "  ✅ $1"; PASS=$((PASS+1)); }
bad()  { echo "  ❌ $1"; FAIL=$((FAIL+1)); }
warn() { echo "  ⚠️  $1"; WARN=$((WARN+1)); }

echo "== 1. Chromium 完整版（旧 headless_shell 不支持扩展，必须是 chrome）=="
CHROME=/root/.cache/ms-playwright/chromium-1234/chrome-linux/chrome
if [ -x "$CHROME" ]; then
  V=$("$CHROME" --headless=new --no-sandbox --version 2>/dev/null | head -1)
  [ -n "$V" ] && ok "$V" || bad "chrome 存在但 --headless=new 起不来（缺库？apt-get install -y libatk-bridge2.0-0）"
else
  bad "缺 Chromium。安装: cd /tmp/pw && npm i playwright-core@1.62.1 && PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.playwright.dev npx playwright-core install chromium --no-shell"
  [ -n "$CHECK_ONLY" ] || exit 1
fi

echo "== 2. 共享库 =="
MISSING=$(ldd "$CHROME" 2>/dev/null | grep "not found" | awk '{print $1}' | sort -u)
if [ -z "$MISSING" ]; then ok "全部共享库就绪"; else
  bad "缺: $MISSING → apt-get install -y libatk-bridge2.0-0（常见）"
  [ -n "$CHECK_ONLY" ] || apt-get install -y --no-install-recommends libatk-bridge2.0-0 && ok "已安装 libatk-bridge2.0-0"
fi

echo "== 3. 扩展 =="
EXT="$SKILL_DIR/assets/extension"
if [ -f "$EXT/manifest.json" ]; then
  KEY=$(python3 -c "import json;print(json.load(open('$EXT/manifest.json')).get('key','') ) " 2>/dev/null)
  [ -n "$KEY" ] && ok "manifest 已含固定 key（扩展 ID 恒定 ahdchbhmgiaciipjijlckjpheflbfiin）" || warn "manifest 无 key → 每次启动扩展 ID 会变，drive.mjs 兜底逻辑可处理但不稳"
else
  bad "缺 $EXT（skill 打包损坏）"; fi
grep -q '"service_worker"' "$EXT/manifest.json" 2>/dev/null && ok "MV3 service_worker 声明正常" || warn "manifest 无 service_worker"

echo "== 4. Node 与脚本 =="
command -v node >/dev/null && ok "node $(node --version)" || bad "缺 node（>=18）"
for f in cdp.mjs drive.mjs feishu_send_file.py; do
  [ -f "$SCRIPT_DIR/$f" ] && ok "scripts/$f" || bad "缺 scripts/$f"
done

echo "== 5. 飞书凭据 =="
if [ -f /root/.hermes/.env ] && grep -q "FEISHU_APP_ID" /root/.hermes/.env 2>/dev/null; then
  ok "FEISHU_APP_ID/SECRET 在 /root/.hermes/.env"
else
  warn "缺飞书凭据 → --feishu 不可用（不影响抓取）"
fi

echo "== 6. 网络 =="
CODE=$(timeout 10 curl -s -o /dev/null -w '%{http_code}' https://www.amazon.com/ 2>/dev/null)
[ "$CODE" = "200" ] && ok "amazon.com 直连 200" || warn "amazon.com 返回 $CODE（代理? robot check?）"

echo
echo "结果: $PASS 通过, $FAIL 失败, $WARN 警告"
[ "$FAIL" -eq 0 ] && echo "环境就绪 → $SCRIPT_DIR/run.sh \"B0XXXXXXX\" --no-reviews --feishu"
exit $FAIL
