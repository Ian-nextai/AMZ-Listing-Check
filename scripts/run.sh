#!/bin/bash
# Amazon Listing Check 一条龙：启动无头 Chromium(带扩展) → 驱动抓取 → xlsx → (可选)发飞书
#
# 用法:
#   ./run.sh "ASIN1,ASIN2,..." [选项]
#     --zip 10010        配送邮编（默认 10010）
#     --delay 1200       ASIN 间隔 ms（默认 1200）
#     --max-image-edge N 图片长边上限 px（默认跟随扩展设置；0 = 不压缩）
#     --with-reviews     差评收集开（默认关！须先登录，见 --check-login/--login）
#     --retry 1          失败 ASIN 自动补跑次数（默认 1）
#     --chunk 8          每批 ASIN 数（默认 0=不分批）；批间清空扩展图片缓存，省内存
#     --feishu           跑完自动发飞书（文件+摘要）；不加则由 agent 在回复中交付文件
#     --feishu-to <id>   接收者（不传则用环境变量 FEISHU_CHAT_ID；发群传 chat_id 并配 --id-type chat_id）
#     --id-type open_id  receive_id_type（默认 open_id）
#     --fresh-profile    删除持久 profile 冷启动（正常情况不要用；邮编/登录态会丢）
#     --check-login      只检测登录态后退出（输出 JSON：loggedIn/greeting）
#     --login            打印无头环境的人工登录指引后退出
#
# 退出码: 0=至少1个ASIN成功  1=链路错误  2=全部ASIN失败  3=差评模式但未登录
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

ASINS="${1:-}"
if [ -z "$ASINS" ] || [[ "$ASINS" == --* ]]; then sed -n '4,19p' "$0"; exit 1; fi
shift

ZIP=10010; DELAY=1200; REVIEWS=""; RETRY=""; FEISHU=""
MAX_IMAGE_EDGE=""; CHUNK=""
FEISHU_TO="${FEISHU_DEFAULT_TO:-}"; ID_TYPE=open_id
FRESH=""; CHECK_LOGIN=""; LOGIN=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2;;
    --delay) DELAY="$2"; shift 2;;
    --max-image-edge) MAX_IMAGE_EDGE="--max-image-edge $2"; shift 2;;
    --chunk) CHUNK="--chunk $2"; shift 2;;
    --with-reviews) REVIEWS="--with-reviews"; shift;;
    --retry) RETRY="--retry $2"; shift 2;;
    --feishu) FEISHU=1; shift;;
    --feishu-to) FEISHU_TO="$2"; shift 2;;
    --id-type) ID_TYPE="$2"; shift 2;;
    --fresh-profile) FRESH=1; shift;;
    --check-login) CHECK_LOGIN=1; shift;;
    --login) LOGIN=1; shift;;
    *) echo "未知选项: $1"; exit 1;;
  esac
done

CHROME="${CHROME:-$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)}"
EXT="$SKILL_DIR/assets/extension"
PROFILE=/root/.hermes/amazon-profile
PORT=19222

[ -x "$CHROME" ] || { echo "缺 Chromium，先跑: $SCRIPT_DIR/setup.sh"; exit 1; }
[ -d "$EXT" ] || { echo "缺扩展目录 $EXT，先跑 setup.sh"; exit 1; }

if [ -n "$LOGIN" ]; then
  echo "无头环境无界面。持久 profile=$PROFILE，人工登录方式："
  echo "  A. 有屏机器: $CHROME --user-data-dir=$PROFILE --load-extension=$EXT https://www.amazon.com/ap/signin"
  echo "     （登录后退出，把整个 $PROFILE 目录拷回本机同路径）"
  echo "  B. 本机临时 X: apt-get install -y xvfb && xvfb-run $CHROME --user-data-dir=$PROFILE --load-extension=$EXT https://www.amazon.com/ap/signin"
  echo "登录完跑: $SCRIPT_DIR/run.sh <ASINs> --check-login 验证"
  exit 0
fi

pkill -f "remote-debugging-port=$PORT" 2>/dev/null && sleep 2
[ -n "$FRESH" ] && rm -rf "$PROFILE"
mkdir -p "$PROFILE"

"$CHROME" --no-sandbox --disable-gpu --headless=new \
  --user-data-dir="$PROFILE" \
  --disable-features=glic \
  --load-extension="$EXT" \
  --remote-debugging-port=$PORT \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!
trap 'kill $CHROME_PID 2>/dev/null || true' EXIT

for i in $(seq 1 30); do
  # -f 必须有：curl 对 connection refused 也返回 0（无 -f 时 -s 只看自身错误），
  # 否则这个循环第一次就 break，Chrome 还没起来就直接去连 → drive.mjs 报 cdp timeout
  curl -sf -o /dev/null "http://127.0.0.1:$PORT/json/version" && break
  sleep 1
done

# 端口没起来就明确失败，别让 drive.mjs 报一个看不懂的 cdp timeout
if ! curl -sf -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
  echo "ERROR: Chromium 未能在 $PORT 上就绪（进程已退出？检查 $PROFILE/SingletonLock 残留）"
  kill $CHROME_PID 2>/dev/null
  exit 1
fi

# 登录态检测（--check-login 显式要 / --with-reviews 隐含要）
if [ -n "$CHECK_LOGIN" ] || [ -n "$REVIEWS" ]; then
  LOGIN_JSON=$(node "$SCRIPT_DIR/check-login.mjs" --port "$PORT")
  echo "LOGIN=$LOGIN_JSON"
  LOGGED=$(echo "$LOGIN_JSON" | python3 -c "import json,sys; print(1 if json.load(sys.stdin).get('loggedIn') else 0)")
  if [ -n "$CHECK_LOGIN" ]; then exit 0; fi
  if [ "$LOGGED" != "1" ]; then
    echo "ERROR: 差评收集需要登录，当前 profile 未登录。"
    echo "登录指引: $SCRIPT_DIR/run.sh --login；登录后重试，或去掉 --with-reviews。"
    kill $CHROME_PID 2>/dev/null
    exit 3
  fi
fi

DRIVE_LOG=$(mktemp)
node "$SCRIPT_DIR/drive.mjs" "$ASINS" --zip "$ZIP" --delay "$DELAY" $REVIEWS $RETRY $MAX_IMAGE_EDGE $CHUNK --port "$PORT" 2>&1 | tee "$DRIVE_LOG"
RC=${PIPESTATUS[0]}

# drive.mjs 用 os.tmpdir() 决定报告路径（Windows 上没有 /tmp），从它自己打印的
# REPORT= 行取，别再写死一份
REPORT=$(sed -n 's/^REPORT=//p' "$DRIVE_LOG" | tail -1)
rm -f "$DRIVE_LOG"
[ -n "$REPORT" ] && [ -f "$REPORT" ] || REPORT=/tmp/amz-last-run.json
if [ ! -f "$REPORT" ]; then
  echo "链路错误（无 report 产物）"
  [ -n "$FEISHU" ] && python3 "$SCRIPT_DIR/feishu_send_file.py" /dev/null "Amazon Listing Check 链路错误，无产物。ASINs: $ASINS" "$FEISHU_TO" "$ID_TYPE" >/dev/null 2>&1 || true
  exit 1
fi
eval "$(python3 -c "
import json
r = json.load(open('$REPORT'))
safe = lambda s, n=200: str(s or '').replace('\"','').replace(chr(10),' ')[:n]
print('N_OK=%d' % r['success'])
print('N_FAIL=%d' % r['failed'])
print('ZIP=%s' % safe(r.get('zip'), 10))
print('REVIEWS=%d' % (1 if r.get('reviewsEnabled') else 0))
print('RETRIED=%d' % r.get('retriedSuccess', 0))
print('MAIN_XLSX=%s' % safe(r.get('mainXlsx')))
print('XLSX_LIST="%s"' % ' '.join(r.get('xlsxFiles') or ([r.get('mainXlsx')] if r.get('mainXlsx') else [])))
print('FAILURES="%s"' % safe('; '.join(r.get('failures') or ['无'])))
")"

DOWNLOADS=/root/Downloads
echo "XLSX:"
for name in $XLSX_LIST; do echo "  $DOWNLOADS/$name"; done

if [ -n "$FEISHU" ]; then
  REV_TXT=$([ "$REVIEWS" = 1 ] && echo 开 || echo 关)
  RETRY_TXT=""
  [ "${RETRIED:-0}" -gt 0 ] && RETRY_TXT="（含自动重试成功 ${RETRIED} 个）"
  SENT=0
  for name in $XLSX_LIST; do
    [ -f "$DOWNLOADS/$name" ] || continue
    python3 "$SCRIPT_DIR/feishu_send_file.py" "$DOWNLOADS/$name" \
      "Amazon Listing Check：${N_OK} 成功 / ${N_FAIL} 失败${RETRY_TXT}（邮编 ${ZIP}，差评收集${REV_TXT}）。
失败明细: ${FAILURES}
完整数据见附件。" \
      "$FEISHU_TO" "$ID_TYPE" >/dev/null && SENT=$((SENT + 1))
  done
  [ "$SENT" -gt 0 ] && echo "已发飞书($FEISHU_TO)，$SENT 个文件" || echo "飞书投递失败（无可发文件）"
else
  echo "未启用 --feishu → agent 须在回复中直接把 $DOWNLOADS 下的 xlsx 作为文件交付给用户"
fi

[ "$RC" -ne 0 ] && exit 1
[ "${N_OK:-0}" -eq 0 ] && exit 2
exit 0
