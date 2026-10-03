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
#     --feishu-to <id>   接收者（不传则用环境变量 FEISHU_CHAT_ID；发私聊配 --id-type union_id，发群配 chat_id）
#     --id-type open_id  receive_id_type（默认 open_id）
#     --fresh-profile    删除持久 profile 冷启动（正常情况不要用；邮编/登录态会丢）
#     --check-login      只检测登录态后退出（输出 JSON：loggedIn/greeting）
#     --login            打印无头环境的人工登录指引后退出
#     --image-proxy hp:port 图片 CDN 改走本地代理（默认不用——扩展自带 CDN 域名回退，
#                        仅在连备用 CDN 域名也取不到时才需要）
#
# 可用环境变量覆盖默认路径（默认全部基于 $HOME，非 root 用户可直接用）:
#   AMZ_PROFILE    Chrome 持久 profile 目录（默认 $HOME/.hermes/amazon-profile）
#   AMZ_DOWNLOADS  xlsx 输出目录（默认 $HOME/Downloads）
#   AMZ_PORT       CDP 调试端口（默认 19222）
#   CHROME         指定 Chromium/Chrome 可执行文件
#
# 退出码: 0=至少1个ASIN成功  1=链路错误  2=全部ASIN失败  3=差评模式但未登录
set -u
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"

ASINS="${1:-}"
if [ -z "$ASINS" ] || [[ "$ASINS" == --* ]]; then sed -n '4,27p' "$0"; exit 1; fi
shift

ZIP=10010; DELAY=1200; REVIEWS=""; RETRY=""; FEISHU=""
MAX_IMAGE_EDGE=""; CHUNK=""
FEISHU_TO="${FEISHU_DEFAULT_TO:-}"; ID_TYPE=open_id
FRESH=""; CHECK_LOGIN=""; LOGIN=""; NO_IMAGES=""
IMAGE_PROXY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --zip) ZIP="$2"; shift 2;;
    --delay) DELAY="$2"; shift 2;;
    --max-image-edge) MAX_IMAGE_EDGE="--max-image-edge $2"; shift 2;;
    --chunk) CHUNK="--chunk $2"; shift 2;;
    --with-reviews) REVIEWS="--with-reviews"; shift;;
    --no-images) NO_IMAGES="--no-images"; shift;;
    --retry) RETRY="--retry $2"; shift 2;;
    --feishu) FEISHU=1; shift;;
    --feishu-to) FEISHU_TO="$2"; shift 2;;
    --id-type) ID_TYPE="$2"; shift 2;;
    --fresh-profile) FRESH=1; shift;;
    --check-login) CHECK_LOGIN=1; shift;;
    --login) LOGIN=1; shift;;
    --image-proxy) IMAGE_PROXY="$2"; shift 2;;
    *) echo "未知选项: $1"; exit 1;;
  esac
done

CHROME="${CHROME:-$(ls -d "${PLAYWRIGHT_BROWSERS_PATH:-$HOME/.cache/ms-playwright}"/chromium-*/chrome-linux*/chrome 2>/dev/null | sort -V | tail -1)}"
EXT="$SKILL_DIR/assets/extension"
# 全部可写路径都基于 $HOME，别写死 /root —— 非 root 用户下会直接 Permission denied。
# 需要固定位置时显式传环境变量覆盖。
PROFILE="${AMZ_PROFILE:-$HOME/.hermes/amazon-profile}"
DOWNLOADS="${AMZ_DOWNLOADS:-$HOME/Downloads}"
PORT="${AMZ_PORT:-19222}"
PORT_PID_FILE="${TMPDIR:-/tmp}/amz-chrome-$PORT.pid"

# 早失败：把「目录不可写」这类问题在启动 Chromium 之前就报清楚，
# 否则表现为 Chrome 起不来 / 任务全失败，很难定位到是路径权限问题。
for _dir in "$PROFILE" "$DOWNLOADS"; do
  if ! mkdir -p "$_dir" 2>/dev/null; then
    echo "错误：无法创建目录 $_dir（当前用户 $(id -un)，HOME=$HOME）" >&2
    echo "      可用 AMZ_PROFILE / AMZ_DOWNLOADS 环境变量指定到可写位置。" >&2
    exit 1
  fi
  if [ ! -w "$_dir" ]; then
    echo "错误：目录不可写 $_dir（当前用户 $(id -un)）" >&2
    echo "      可用 AMZ_PROFILE / AMZ_DOWNLOADS 环境变量指定到可写位置。" >&2
    exit 1
  fi
done

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

# 按 PID 精确回收上一轮残留，不要用 pkill -f：调用方 shell 的命令行里往往
# 带着整条命令（含 --remote-debugging-port=19222），模式匹配会把它连同本脚本
# 一起杀掉，表现为 Chrome 从未启动、drive.mjs 报 cdp timeout。
if [ -f "$PORT_PID_FILE" ]; then
  OLD_PID=$(cat "$PORT_PID_FILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "$$" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    kill "$OLD_PID" 2>/dev/null
    sleep 2
  fi
  rm -f "$PORT_PID_FILE"
fi
# Chrome 被 kill 后 SingletonLock 不会自动清；陈旧锁会让下一批任务以为
# 「另一个实例在用这个 profile」而立即退出（cdp timeout）。锁文件只在
# 持锁进程存活时有效，这里在启动前把指向死进程（或无进程）的锁清掉。
for LOCK in "$PROFILE"/Singleton*; do
  [ -e "$LOCK" ] || continue
  LOCK_PID=$(readlink "$LOCK" 2>/dev/null | sed 's/.*-//')
  if [ -z "$LOCK_PID" ] || ! kill -0 "$LOCK_PID" 2>/dev/null; then
    rm -f "$LOCK"
  fi
done
[ -n "$FRESH" ] && rm -rf "$PROFILE"
mkdir -p "$PROFILE"

# MV3 service worker 的模块图会被 profile 缓存住：改了扩展代码、只重启浏览器
# 甚至 bump manifest 版本都不够——扩展页面（runner.html）读到的是新文件，
# 而任务实际跑在 SW 里，读的是旧模块。表现是任务照常成功、却导出旧列
# （排查耗费很久：一次静默丢了三列）。启动前清掉 SW 缓存，强制重新注册。
# 只删 Service Worker 目录：cookie 与登录态在 Default/Cookies，不受影响。
rm -rf "$PROFILE/Default/Service Worker"

# 图片 CDN 定向代理（可选，规则见 scripts/proxy.pac）。
# 主修复在扩展层：m.media-amazon.com 被按 SNI 阻断时，扩展会自带回退到
# images-na / images-fe 等等价主机（同路径同字节），所以默认不需要代理。
# 只有在连备用 CDN 域名也取不到的网络下，才用 --image-proxy 交给本地代理。
# 注意 PAC 必须经 HTTP 提供：--proxy-pac-url=file:// 实测被 Chrome 静默忽略。
PAC_PID=""; PAC_ARG=""; PAC_DIR=""
if [ -n "$IMAGE_PROXY" ] && [ -z "${NO_IMAGES:-}" ]; then
  # 用真实目标探测：返回任何 HTTP 码都算通路，000 才是真不通。
  PROXY_CODE=$(curl -x "http://$IMAGE_PROXY" -s -o /dev/null -w '%{http_code}' --max-time 8 \
    "https://m.media-amazon.com/images/" 2>/dev/null || echo 000)
  if [ "$PROXY_CODE" != "000" ]; then
    PAC_DIR=$(mktemp -d)
    sed "s|__IMAGE_PROXY__|$IMAGE_PROXY|" "$SCRIPT_DIR/proxy.pac" > "$PAC_DIR/proxy.pac"
    PAC_PORT=""
    for p in 8899 8900 8901 8902 8903; do
      if ! curl -s -o /dev/null --max-time 2 "http://127.0.0.1:$p/" 2>/dev/null; then PAC_PORT=$p; break; fi
    done
    [ -n "$PAC_PORT" ] || { echo "ERROR: 8899-8903 都被占用，无法提供 PAC"; exit 1; }
    ( cd "$PAC_DIR" && exec python3 -m http.server "$PAC_PORT" --bind 127.0.0.1 ) >/dev/null 2>&1 &
    PAC_PID=$!
    for i in $(seq 1 20); do
      curl -sf -o /dev/null "http://127.0.0.1:$PAC_PORT/proxy.pac" && break
      sleep 0.5
    done
    PAC_ARG="--proxy-pac-url=http://127.0.0.1:$PAC_PORT/proxy.pac"
    echo "图片代理: 开（*.media-amazon.com → $IMAGE_PROXY；PAC http://127.0.0.1:$PAC_PORT/proxy.pac）"
  else
    echo "图片代理: 关（$IMAGE_PROXY 取不到图，图片走直连）——若 CDN 被墙，A图/详情图 会缺"
  fi
fi

# 端口必须先真正关闭：若上一轮 Chrome 没死透，新实例会因 profile 锁起不来，
# 而端口探测仍会连上那个旧实例——它带着旧扩展跑完整批任务，静默产出错误列。
# 这种「结果看起来正常但是旧的」比直接报错危险得多，所以这里等到端口关闭为止。
PORT_WAS_OPEN=0
for i in $(seq 1 30); do
  if curl -sf -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
    PORT_WAS_OPEN=1
    sleep 1
  else
    break
  fi
done
if [ "$PORT_WAS_OPEN" = "1" ] && curl -sf -o /dev/null "http://127.0.0.1:$PORT/json/version"; then
  echo "ERROR: $PORT 上仍有旧 Chromium 在运行，拒绝复用（它会带着旧扩展产出错误结果）。"
  echo "请先停掉占用该端口的进程：ss -tlnp | grep $PORT"
  exit 1
fi

"$CHROME" --no-sandbox --disable-gpu --headless=new \
  --user-data-dir="$PROFILE" \
  --disable-features=glic \
  --load-extension="$EXT" \
  $PAC_ARG \
  --remote-debugging-port=$PORT \
  about:blank >/dev/null 2>&1 &
CHROME_PID=$!
echo "$CHROME_PID" > "$PORT_PID_FILE"
# trap 也按 PID 杀，不走 pkill（同上：模式匹配会误伤调用方 shell）；顺带回收 PAC 服务
trap 'kill "$CHROME_PID" 2>/dev/null || true; [ -n "${PAC_PID:-}" ] && kill "$PAC_PID" 2>/dev/null || true; rm -f "$PORT_PID_FILE"; [ -n "${PAC_DIR:-}" ] && rm -rf "$PAC_DIR" || true; [ -n "${XLSX_LIST_FILE:-}" ] && rm -f "$XLSX_LIST_FILE" || true' EXIT

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
# 报告里的短值用 eval 赋值即可，但文件名列表必须走临时文件：批量跑时几十个文件名
# 会被拼成一条 2700+ 字符的赋值，穿过 python -c "..." 、$(...) 、eval 三层后引号会
# 被吃掉，shell 把第二个文件名当成命令执行（command not found），赋值被破坏后
# XLSX_LIST 在 set -u 下报 unbound variable，退出码 1 —— 抓取本身其实全成功，
# 却看起来像任务失败。单个文件时不复现，所以小批量测试永远暴露不了。
XLSX_LIST_FILE=$(mktemp)
eval "$(python3 -c "
import json, sys
r = json.load(open('$REPORT'))
safe = lambda s, n=200: str(s or '').replace('\"','').replace(chr(10),' ')[:n]
print('N_OK=%d' % r['success'])
print('N_FAIL=%d' % r['failed'])
print('ZIP=%s' % safe(r.get('zip'), 10))
print('REVIEWS=%d' % (1 if r.get('reviewsEnabled') else 0))
print('RETRIED=%d' % r.get('retriedSuccess', 0))
print('MAIN_XLSX=%s' % safe(r.get('mainXlsx')))
print('FAILURES=\"%s\"' % safe('; '.join(r.get('failures') or ['无'])))
names = r.get('xlsxFiles') or ([r.get('mainXlsx')] if r.get('mainXlsx') else [])
with open(sys.argv[1], 'w') as handle:
    for name in names:
        if name:
            handle.write(str(name) + chr(10))
" "$XLSX_LIST_FILE")"

echo "XLSX:"
while IFS= read -r name; do
  [ -n "$name" ] && echo "  $DOWNLOADS/$name"
done < "$XLSX_LIST_FILE"

# 产物守卫：表头必须含本次启用检查项对应的列。曾出现「任务成功、却导出旧列」的
# 静默错误（扩展代码更新后 SW 仍加载旧模块），所以这里校验产物本身而不是运行过程。
if [ -n "$MAIN_XLSX" ] && [ -f "$DOWNLOADS/$MAIN_XLSX" ]; then
  REQUIRED_LABELS="ASIN,Status,产品价格,优惠券,折扣,Title,Rating,BP,Category,Seller"
  if [ "$REVIEWS" = "--with-reviews" ]; then REQUIRED_LABELS="$REQUIRED_LABELS,差评"; fi
  if ! node "$SCRIPT_DIR/check-xlsx-header.mjs" "$DOWNLOADS/$MAIN_XLSX" "$REQUIRED_LABELS"; then
    echo "ERROR: 产物表头与本次启用的检查项不符 —— 极可能是扩展代码更新后仍在跑旧模块。"
    echo "  处理：run.sh 会清 Service Worker 缓存；若仍复现，改扩展代码后需 bump manifest version。"
    exit 1
  fi
fi

if [ -n "$FEISHU" ]; then
  REV_TXT=$([ "$REVIEWS" = 1 ] && echo 开 || echo 关)
  RETRY_TXT=""
  [ "${RETRIED:-0}" -gt 0 ] && RETRY_TXT="（含自动重试成功 ${RETRIED} 个）"
  SENT=0
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    [ -f "$DOWNLOADS/$name" ] || continue
    python3 "$SCRIPT_DIR/feishu_send_file.py" "$DOWNLOADS/$name" \
      "Amazon Listing Check：${N_OK} 成功 / ${N_FAIL} 失败${RETRY_TXT}（邮编 ${ZIP}，差评收集${REV_TXT}）。
失败明细: ${FAILURES}
完整数据见附件。" \
      "$FEISHU_TO" "$ID_TYPE" >/dev/null && SENT=$((SENT + 1))
  done < "$XLSX_LIST_FILE"
  [ "$SENT" -gt 0 ] && echo "已发飞书($FEISHU_TO)，$SENT 个文件" || echo "飞书投递失败（无可发文件）"
else
  echo "未启用 --feishu → agent 须在回复中直接把 $DOWNLOADS 下的 xlsx 作为文件交付给用户"
fi

[ "$RC" -ne 0 ] && exit 1
[ "${N_OK:-0}" -eq 0 ] && exit 2
exit 0
