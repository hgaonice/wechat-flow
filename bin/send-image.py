#!/usr/bin/env python3
"""
Send an image (e.g. the WeChat login QR screenshot) as an email attachment.

Reuses the credentials from the pre-installed `email-sender` skill's config.env,
so no extra config is needed. This is a bootstrap helper for the one-time
WeChat login step (the skill itself only attaches a text/markdown file).
"""
import argparse
import os
import smtplib
import sys
from email.header import Header
from email.mime.image import MIMEImage
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.utils import formataddr

SKILL_DIR = os.environ.get("EMAIL_SKILL_DIR", "/root/.claude/skills/email-sender")
CONFIG_PATH = os.path.join(SKILL_DIR, "config.env")


def load_config() -> dict:
    if not os.path.exists(CONFIG_PATH):
        print(f"❌ 未找到 {CONFIG_PATH}", file=sys.stderr)
        sys.exit(1)
    cfg = {}
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            cfg[k.strip()] = v.strip()
    for k in ("SMTP_SERVER", "SMTP_PORT", "SENDER_EMAIL", "SENDER_PASSWORD"):
        if k not in cfg:
            print(f"❌ 配置缺失: {k}", file=sys.stderr)
            sys.exit(1)
    return cfg


def main() -> None:
    ap = argparse.ArgumentParser(description="通过 email-sender 的账号发送图片附件邮件")
    ap.add_argument("-i", "--image", required=True, help="图片路径")
    ap.add_argument("-s", "--subject", default="来自服务器的邮件", help="邮件主题")
    ap.add_argument("-b", "--body", default="", help="邮件正文")
    ap.add_argument("-t", "--to", help="收件人（默认发给配置里的收件人）")
    args = ap.parse_args()

    if not os.path.exists(args.image):
        print(f"❌ 图片不存在: {args.image}", file=sys.stderr)
        sys.exit(1)

    cfg = load_config()
    to_email = args.to or cfg.get("RECEIVER_EMAIL", cfg["SENDER_EMAIL"])

    msg = MIMEMultipart()
    msg["From"] = formataddr((str(Header("AiCoding", "utf-8")), cfg["SENDER_EMAIL"]))
    msg["To"] = to_email
    msg["Subject"] = Header(args.subject, "utf-8")
    msg.attach(MIMEText(args.body or "见附件。", "plain", "utf-8"))

    with open(args.image, "rb") as f:
        img = MIMEImage(f.read())
    img.add_header("Content-Disposition", "attachment", filename=os.path.basename(args.image))
    msg.attach(img)

    with smtplib.SMTP_SSL(cfg["SMTP_SERVER"], int(cfg["SMTP_PORT"])) as server:
        server.login(cfg["SENDER_EMAIL"], cfg["SENDER_PASSWORD"])
        server.sendmail(cfg["SENDER_EMAIL"], to_email, msg.as_string())

    print(f"✅ 图片已发送到 {to_email}")


if __name__ == "__main__":
    main()
