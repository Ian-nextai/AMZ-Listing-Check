#!/usr/bin/env python3
"""Upload a file and send it as a file message on Feishu (raw API, explicit feedback)."""
import glob
import json
import mimetypes
import os
import sys
import urllib.request
import urllib.error
import uuid

PATH = sys.argv[1]
DESC = sys.argv[2] if len(sys.argv) > 2 else "文件"
RECEIVE_ID = sys.argv[3] if len(sys.argv) > 3 else os.environ.get("FEISHU_CHAT_ID", "")
RECEIVE_TYPE = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("FEISHU_ID_TYPE", "chat_id")

# Credentials live wherever this host keeps its Hermes env file: an explicit
# override first, then the classic location, then any profile's env file.
def env_candidates():
    home = os.path.expanduser("~")
    explicit = os.environ.get("HERMES_ENV_FILE", "")
    return [p for p in [explicit, f"{home}/.hermes/.env"] if p] + sorted(glob.glob(f"{home}/.hermes/profiles/*/.env"))

env = {}
for candidate in env_candidates():
    try:
        with open(candidate) as f:
            parsed = {}
            for line in f:
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    parsed[k] = v
    except OSError:
        continue
    for k, v in parsed.items():
        env.setdefault(k, v)  # first file that has the key wins

missing = [k for k in ("FEISHU_APP_ID", "FEISHU_APP_SECRET") if not env.get(k)]
if missing:
    print(f"缺 {'/'.join(missing)}（查过: {', '.join(env_candidates()) or '无'}）")
    sys.exit(1)
if not RECEIVE_ID:
    print("缺接收者：传第 3 个参数或设 FEISHU_CHAT_ID")
    sys.exit(1)

def api(url, data=None, headers=None, is_json=True):
    h = dict(headers or {})
    body = data
    if data is not None and is_json:
        body = json.dumps(data).encode()
        h.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=h)
    try:
        return json.load(urllib.request.urlopen(req, timeout=60))
    except urllib.error.HTTPError as e:
        print("HTTP", e.code, e.read().decode()[:300])
        sys.exit(1)

tok = api("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
          {"app_id": env["FEISHU_APP_ID"], "app_secret": env["FEISHU_APP_SECRET"]})["tenant_access_token"]
H = {"Authorization": f"Bearer {tok}"}

# 1. upload file
boundary = uuid.uuid4().hex
fname = os.path.basename(PATH)
ctype = mimetypes.guess_type(fname)[0] or "application/octet-stream"
body = (f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file_type"\r\n\r\nstream\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file_name"\r\n\r\n{fname}\r\n'
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{fname}"\r\n'
        f"Content-Type: {ctype}\r\n\r\n").encode() + open(PATH, "rb").read() + f"\r\n--{boundary}--\r\n".encode()
r = api("https://open.feishu.cn/open-apis/im/v1/files?file_type=stream", data=body,
        headers={"Authorization": f"Bearer {tok}", "Content-Type": f"multipart/form-data; boundary={boundary}"},
        is_json=False)
print("upload:", json.dumps({k: r.get(k) for k in ("code", "msg")}), "file_key =", r.get("data", {}).get("file_key"))
if r.get("code") != 0:
    sys.exit(1)
file_id = r["data"]["file_key"]

# 2. send as file message
payload = {"receive_id": RECEIVE_ID, "msg_type": "file",
           "content": json.dumps({"file_key": file_id}, separators=(",", ":"))}
print("send payload:", json.dumps(payload)[:200])
r = api("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=" + RECEIVE_TYPE, payload, headers=H)
print("send:", json.dumps({k: r.get(k) for k in ("code", "msg")}), "message_id =", r.get("data", {}).get("message_id"))
if r.get("code") == 0:
    # 3. send caption text after the file
    r2 = api("https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=" + RECEIVE_TYPE,
             {"receive_id": RECEIVE_ID, "msg_type": "text", "content": json.dumps({"text": DESC})}, headers=H)
    print("caption:", json.dumps({k: r2.get(k) for k in ("code", "msg")}))
