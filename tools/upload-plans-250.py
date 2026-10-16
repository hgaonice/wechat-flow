#!/usr/bin/env python3
"""把本机生成的 out/plans/<alias>/<week>.json 上传到 250 控制台（DB 真源）。

流程：ssh 到 250 → POST /api/login 拿 cookie+csrf → 逐周 PUT /api/accounts/:id/plans。
幂等：upsertPlan 天然幂等，重跑安全。凭据不落 git（本脚本只读服务器本地文件）。

用法：
  python3 tools/upload-plans-250.py                # 全量上传 second + gaoh
  python3 tools/upload-plans-250.py --alias second # 只传一个账号
  python3 tools/upload-plans-250.py --weeks 2026-W42,2026-W43
"""
import argparse
import json
import subprocess
import sys
from pathlib import Path

HOST = "root@192.168.0.250"
REMOTE_DIR = "/root/wechat-flow"
BASE = "http://127.0.0.1:8787"  # console HTTP listener on 250
PLANS_DIR = Path(__file__).resolve().parent.parent / "out" / "plans"

ACCOUNT_IDS = {"second": 1, "gaoh": 2}


def shquote(s: str) -> str:
    """Single-quote a value for the remote shell (values never contain single quotes here)."""
    return "'" + s + "'"


def remote_read(path: str) -> str:
    r = subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, f"cat {path}"],
                       capture_output=True, text=True, check=True)
    return r.stdout


def ssh_curl(url: str, *, method: str = "GET", data_file: str | None = None,
             headers: list[str] | None = None) -> tuple[int, str, dict[str, str]]:
    """Run curl on 250 (BASE is loopback-only there) and return (http_code, body, resp_headers).

    Everything is written to temp files on 250; stdout is kept clean because
    some environments (trellis proxy etc.) prepend their own output.
    """
    hdr_args = []
    for h in headers or []:
        hdr_args += ["-H", shquote(h)]
    cmd = [
        "curl", "-s", "--noproxy", "'*'",  # 远端 shell 需要 quoting
        "-o", "/tmp/_resp_body",
        "-D", "/tmp/_resp_hdr",
        "-w", "'%{http_code}'",
        *([] if method == "GET" else ["-X", shquote(method)]), *hdr_args,
    ]
    if data_file:
        cmd += ["--data-binary", shquote(f"@{data_file}")]
    cmd.append(shquote(url))
    # 全部重定向：stdout 不可靠（有代理噪音行混入），code 也写文件
    wrapped = " ".join(cmd) + " > /tmp/_resp_code 2>/dev/null"
    # 250 的 sshd 会注入 http_proxy(7890)，对 POST 会经代理产生 502 噪音 → env -u 清掉
    subprocess.run(["ssh", "-o", "BatchMode=yes", HOST, f"env -u http_proxy -u https_proxy {wrapped}"],
                   capture_output=True, text=True, check=True)
    code_lines = [l for l in remote_read("/tmp/_resp_code").strip().splitlines() if l.strip().isdigit()]
    if not code_lines:
        sys.exit(f"curl 未写出 HTTP 状态码（_resp_code 内容异常）：{remote_read('/tmp/_resp_code')[:200]}")
    code = int(code_lines[-1])
    body = remote_read("/tmp/_resp_body")
    try:
        hdr_text = remote_read("/tmp/_resp_hdr")
    except subprocess.CalledProcessError:
        hdr_text = ""
    hdrs = {}
    for line in hdr_text.splitlines():
        if ":" in line:
            k, v = line.split(":", 1)
            hdrs[k.strip().lower()] = v.strip()
    return code, body, hdrs


def login() -> tuple[str, str]:
    """Read admin credentials from the 250-local file, log in, return (cookie, csrf)."""
    note = remote_read(f"{REMOTE_DIR}/.credentials-note")
    user = password = ""
    for line in note.splitlines():
        if "控制台账号" in line:
            user = line.split(":", 1)[1].strip()
        elif "控制台密码" in line:
            password = line.split(":", 1)[1].strip()
    if not user or not password:
        sys.exit("无法从 .credentials-note 解析控制台凭据")

    payload_file = "/tmp/_login_body"
    subprocess.run(["ssh", "-o", "BatchMode=yes", HOST,
                    f"printf '%s' {json.dumps(json.dumps({'username': user, 'password': password}))} > {payload_file}"],
                   check=True)
    code, body, hdrs = ssh_curl(f"{BASE}/api/login", method="POST", data_file=payload_file,
                                headers=["content-type: application/json"])
    if code != 200:
        sys.exit(f"登录失败 HTTP {code}: {body[:200]}")
    payload = json.loads(body)
    cookie = (hdrs.get("set-cookie", "")).split(";")[0]
    csrf = payload.get("data", {}).get("csrfToken", "")
    if not cookie or not csrf:
        sys.exit(f"登录响应缺 cookie/csrf: {body[:200]}")
    return cookie, csrf


def put_plan(cookie: str, csrf: str, account_id: int, week: str, plan: dict) -> None:
    body = json.dumps({"period_type": "week", "period_key": week, "items": plan})
    payload_file = "/tmp/_plan_body.json"
    subprocess.run(
        ["ssh", "-o", "BatchMode=yes", HOST, "cat > " + payload_file],
        input=body, text=True, check=True,
    )
    code, out, _ = ssh_curl(
        f"{BASE}/api/accounts/{account_id}/plans", method="PUT", data_file=payload_file,
        headers=["content-type: application/json", f"cookie: {cookie}", f"x-csrf-token: {csrf}"],
    )
    parsed = json.loads(out)
    if code != 200 or not parsed.get("ok", False):
        raise RuntimeError(f"PUT {week} HTTP {code}: {out[:200]}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--alias", choices=list(ACCOUNT_IDS), action="append")
    ap.add_argument("--weeks", help="逗号分隔的周 key，默认全部")
    args = ap.parse_args()

    aliases = args.alias or list(ACCOUNT_IDS)
    cookie, csrf = login()
    print(f"登录 OK（csrf {csrf[:8]}…）")

    only_weeks = set(args.weeks.split(",")) if args.weeks else None
    for alias in aliases:
        d = PLANS_DIR / alias
        files = sorted(d.glob("2026-W*.json")) + sorted(d.glob("2027-W*.json"))
        if only_weeks:
            files = [f for f in files if f.stem in only_weeks]
        total_days = 0
        for f in files:
            plan = json.loads(f.read_text())
            n = len(plan["days"])
            total_days += n
            put_plan(cookie, csrf, ACCOUNT_IDS[alias], f.stem, plan)
            print(f"[{alias}] {f.stem} ✓ ({n} 天)")
        print(f"[{alias}] 合计 {total_days} 天 / {len(files)} 周")


if __name__ == "__main__":
    main()
