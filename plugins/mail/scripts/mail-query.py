#!/usr/bin/env python3
"""dsh-wfxm 邮件只读查询（J1）。

协议：从 stdin 读一个 JSON，向 stdout 写一个 JSON。密码只在 stdin 里，
不会出现在 argv / 进程列表中；IMAP 始终以只读方式打开，不发送、不删除、
不标记已读、不移动。

输入：
  {"action":"search","account":{host,port,secure,user,password},"request":{...}}
  {"action":"read","account":{...},"request":{"uid":123,"maxChars":4000}}
  {"action":"self-test"}
"""

from __future__ import annotations

import email
import email.policy
import imaplib
import json
import re
import socket
import sys
from datetime import datetime
from email.header import decode_header
from email.parser import BytesParser
from html.parser import HTMLParser

MAX_LIMIT = 50
DEFAULT_LIMIT = 20
MAX_SCAN = 200
MAX_BODY_CAP = 20000
DEFAULT_BODY = 4000
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class MailError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


class _TextExtractor(HTMLParser):
    """把 HTML 邮件正文压成纯文本；跳过 script/style。"""

    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []
        self._skip = False

    def handle_starttag(self, tag, attrs):  # noqa: D102 - HTMLParser 回调
        if tag in ("script", "style"):
            self._skip = True
        elif tag in ("br", "p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_endtag(self, tag):  # noqa: D102
        if tag in ("script", "style"):
            self._skip = False
        elif tag in ("p", "div", "li", "tr"):
            self.parts.append("\n")

    def handle_data(self, data):  # noqa: D102
        if not self._skip:
            self.parts.append(data)


def html_to_text(html: str) -> str:
    parser = _TextExtractor()
    try:
        parser.feed(html)
    except Exception:  # 非标准 HTML 时不猜结构，原样返回
        return html.strip()
    text = "".join(parser.parts)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def decode_header_value(value) -> str:
    if value is None:
        return ""
    raw = str(value)
    try:
        parts = decode_header(raw)
    except Exception:
        return raw.strip()
    out: list[str] = []
    for chunk, charset in parts:
        if isinstance(chunk, bytes):
            try:
                out.append(chunk.decode(charset or "utf-8", errors="replace"))
            except LookupError:
                out.append(chunk.decode("latin-1", errors="replace"))
        else:
            out.append(chunk)
    return "".join(out).strip()


def imap_date(value: str) -> str:
    """`YYYY-MM-DD` → IMAP 的 `18-Nov-2026`。"""
    try:
        return datetime.strptime(value, "%Y-%m-%d").strftime("%d-%b-%Y")
    except ValueError as error:
        raise MailError("protocol", f"invalid date {value!r}, expected YYYY-MM-DD") from error


def part_text(part) -> str:
    payload = part.get_payload(decode=True) or b""
    charset = part.get_content_charset() or "utf-8"
    try:
        return payload.decode(charset, errors="replace")
    except LookupError:
        return payload.decode("latin-1", errors="replace")


def extract_body(msg, max_chars: int):
    """返回 (正文, 是否截断, 附件清单)；优先 text/plain，回退 HTML。"""
    plains: list[str] = []
    htmls: list[str] = []
    attachments: list[dict] = []
    for part in msg.walk():
        if part.is_multipart():
            continue
        filename = part.get_filename()
        disposition = (part.get("Content-Disposition") or "").lower()
        if filename is not None or "attachment" in disposition:
            payload = part.get_payload(decode=True) or b""
            attachments.append({
                "name": decode_header_value(filename) or "attachment",
                "sizeBytes": len(payload),
            })
            continue
        ctype = part.get_content_type()
        if ctype == "text/plain":
            plains.append(part_text(part))
        elif ctype == "text/html":
            htmls.append(part_text(part))

    body = "\n".join(chunk for chunk in plains if chunk.strip())
    if body.strip() == "" and htmls:
        body = html_to_text("\n".join(htmls))
    body = body.strip()
    truncated = len(body) > max_chars
    return body[:max_chars], truncated, attachments


def has_non_ascii(*values) -> bool:
    return any(value is not None and str(value) != "" and not str(value).isascii() for value in values)


def quote(value: str) -> str:
    return '"' + str(value).replace('"', '\\"') + '"'


def fetch_headers(imap, uids: list[int]) -> list[dict]:
    if not uids:
        return []
    typ, data = imap.uid(
        "FETCH",
        ",".join(str(uid) for uid in uids),
        "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[HEADER.FIELDS (DATE FROM TO SUBJECT)])",
    )
    if typ != "OK":
        raise MailError("protocol", f"FETCH failed: {data!r}")

    parsed: dict[int, dict] = {}
    for item in data:
        if not isinstance(item, tuple):
            continue
        meta = item[0].decode("ascii", "replace") if isinstance(item[0], bytes) else str(item[0])
        match = re.search(r"UID (\d+)", meta)
        if match is None:
            continue
        uid = int(match.group(1))
        flags = re.search(r"FLAGS \(([^)]*)\)", meta)
        size = re.search(r"RFC822\.SIZE (\d+)", meta)
        internal = re.search(r'INTERNALDATE "([^"]+)"', meta)
        message = BytesParser(policy=email.policy.default).parsebytes(item[1])
        parsed[uid] = {
            "uid": uid,
            "date": decode_header_value(message.get("Date")) or (internal.group(1) if internal else ""),
            "from": decode_header_value(message.get("From")),
            "to": decode_header_value(message.get("To")),
            "subject": decode_header_value(message.get("Subject")),
            "sizeBytes": int(size.group(1)) if size else 0,
            "seen": "\\Seen" in (flags.group(1) if flags else ""),
        }
    return [parsed[uid] for uid in uids if uid in parsed]


def matches_local(message: dict, request: dict) -> bool:
    for field in ("from", "subject"):
        needle = request.get(field)
        if needle and str(needle).lower() not in message[field].lower():
            return False
    query = request.get("query")
    if query:
        haystack = f"{message['from']}\n{message['subject']}\n{message['to']}".lower()
        if str(query).lower() not in haystack:
            return False
    return True


def search_mail(imap, request: dict) -> dict:
    limit = request.get("limit", DEFAULT_LIMIT)
    local_filter = has_non_ascii(request.get("query"), request.get("from"), request.get("subject"))

    criteria: list[str] = []
    if request.get("since"):
        criteria += ["SINCE", imap_date(request["since"])]
    if request.get("before"):
        criteria += ["BEFORE", imap_date(request["before"])]
    if not local_filter:
        if request.get("from"):
            criteria += ["FROM", quote(request["from"])]
        if request.get("subject"):
            criteria += ["SUBJECT", quote(request["subject"])]
        if request.get("query"):
            criteria += ["TEXT", quote(request["query"])]
    if not criteria:
        criteria = ["ALL"]

    typ, data = imap.uid("SEARCH", None, *criteria)
    if typ != "OK":
        raise MailError("protocol", f"SEARCH failed: {data!r}")
    uids = [int(value) for value in (data[0] or b"").split() if value.isdigit()]
    uids.reverse()

    if local_filter:
        # 中文等非 ASCII 条件不走服务器 SEARCH（各家 IMAP 支持不一），
        # 改为扫描最近 MAX_SCAN 封的头部并本地过滤，结果里标注 scanned。
        scanned_uids = uids[:MAX_SCAN]
        messages = [item for item in fetch_headers(imap, scanned_uids) if matches_local(item, request)]
        return {
            "mailbox": "INBOX",
            "total": len(messages),
            "scanned": len(scanned_uids),
            "localFilter": True,
            "messages": messages[:limit],
        }

    selected = uids[:limit]
    messages = fetch_headers(imap, selected)
    return {
        "mailbox": "INBOX",
        "total": len(uids),
        "scanned": len(selected),
        "localFilter": False,
        "messages": messages,
    }


def read_mail(imap, request: dict) -> dict:
    uid = int(request.get("uid"))
    max_chars = min(int(request.get("maxChars", DEFAULT_BODY)), MAX_BODY_CAP)
    typ, data = imap.uid("FETCH", str(uid), "(UID FLAGS INTERNALDATE RFC822.SIZE BODY.PEEK[])")
    if typ != "OK":
        raise MailError("protocol", f"FETCH failed: {data!r}")
    for item in data:
        if not isinstance(item, tuple):
            continue
        message = BytesParser(policy=email.policy.default).parsebytes(item[1])
        body, truncated, attachments = extract_body(message, max_chars)
        return {
            "uid": uid,
            "date": decode_header_value(message.get("Date")),
            "from": decode_header_value(message.get("From")),
            "to": decode_header_value(message.get("To")),
            "subject": decode_header_value(message.get("Subject")),
            "text": body,
            "truncated": truncated,
            "attachments": attachments,
        }
    raise MailError("protocol", f"uid {uid} not found in INBOX")


def send_client_id(imap) -> None:
    """163/126 要求客户端先发 IMAP ID，否则 SELECT 返回 Unsafe Login。

    imaplib 没有公开 API；RFC 2971 的 ID 必须用 xatom 发完整命令并读回 tagged
    响应（`_simple_command` + `_untagged_response("ID")` 会拿不到 ID 响应）。
    失败不影响其他服务商。
    """
    try:
        imap.xatom(
            "ID",
            '("name" "dsh-wfxm" "version" "1.0" "vendor" "dsh-wfxm" '
            '"support-email" "cuiyangjs@163.com")',
        )
    except Exception:
        return


def connect(account: dict):
    host = account.get("host")
    user = account.get("user")
    password = account.get("password")
    if not host or not user or not password:
        raise MailError("config", "mail account is missing host/user/password")
    port = int(account.get("port", 993))
    try:
        imap = imaplib.IMAP4_SSL(host, port, timeout=15)
    except (socket.timeout, TimeoutError) as error:
        raise MailError("timeout", f"connect to {host}:{port} timed out") from error
    except OSError as error:
        raise MailError("network", f"cannot connect to {host}:{port}: {error}") from error
    try:
        imap.login(user, password)
    except imaplib.IMAP4.error as error:
        raise MailError("auth", f"login failed: {error}") from error
    send_client_id(imap)
    try:
        typ, data = imap.select("INBOX", readonly=True)
    except imaplib.IMAP4.error as error:
        raise MailError("protocol", f"cannot open INBOX: {error}") from error
    if typ != "OK":
        raise MailError("protocol", f"cannot open INBOX: {data!r}")
    return imap


def self_test() -> int:
    checks: list[str] = []

    def check(name: str, condition: bool) -> None:
        if not condition:
            raise MailError("protocol", f"self-test failed: {name}")
        checks.append(name)

    check("decode header", decode_header_value("=?UTF-8?B?5L2g5aW9?=") == "你好")
    check("imap date", imap_date("2026-11-18") == "18-Nov-2026")
    check("html text", html_to_text("<p>hi<br>there</p>").replace("\n\n", "\n") == "hi\nthere")

    raw = (
        "From: =?UTF-8?B?5byg5LiJ?= <a@example.com>\r\n"
        "To: b@example.com\r\n"
        "Subject: =?UTF-8?B?5L2g5aW9?=\r\n"
        "Date: Tue, 18 Nov 2026 10:00:00 +0800\r\n"
        "MIME-Version: 1.0\r\n"
        'Content-Type: multipart/mixed; boundary="BOUND"\r\n'
        "\r\n"
        "--BOUND\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        "\r\n"
        "Hello 世界\r\n"
        "--BOUND\r\n"
        "Content-Type: text/html; charset=utf-8\r\n"
        "\r\n"
        "<p>ignored</p>\r\n"
        "--BOUND\r\n"
        "Content-Type: text/plain; charset=utf-8\r\n"
        'Content-Disposition: attachment; filename="a.txt"\r\n'
        "\r\n"
        "attached\r\n"
        "--BOUND--\r\n"
    ).encode("utf-8")
    message = BytesParser(policy=email.policy.default).parsebytes(raw)
    body, truncated, attachments = extract_body(message, DEFAULT_BODY)
    check("plain body wins", body.startswith("Hello 世界"))
    check("not truncated", truncated is False)
    check("attachment listed", len(attachments) == 1 and attachments[0]["name"] == "a.txt")
    check("attachment not in body", "attached" not in body)
    check("subject decoded", decode_header_value(message.get("Subject")) == "你好")
    check("local filter", matches_local({"from": "张三 <a@example.com>", "subject": "你好", "to": ""}, {"subject": "你好"}))
    check("non-ascii detection", has_non_ascii("你好") and not has_non_ascii("hello"))

    print(json.dumps({"ok": True, "checks": len(checks)}, ensure_ascii=False))
    return 0


def emit_error(code: str, message: str) -> int:
    print(json.dumps({"ok": False, "code": code, "message": message}, ensure_ascii=False))
    return 0


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw)
    except json.JSONDecodeError as error:
        return emit_error("protocol", f"bad json input: {error}")

    action = payload.get("action")
    if action == "self-test":
        return self_test()
    if action not in ("search", "read"):
        return emit_error("protocol", f"unknown action {action!r}")

    imap = None
    try:
        request = payload.get("request") or {}
        imap = connect(payload.get("account") or {})
        result = search_mail(imap, request) if action == "search" else read_mail(imap, request)
        print(json.dumps({"ok": True, **result}, ensure_ascii=False))
        return 0
    except MailError as error:
        return emit_error(error.code, error.message)
    except (socket.timeout, TimeoutError) as error:
        return emit_error("timeout", str(error))
    except OSError as error:
        return emit_error("network", str(error))
    except imaplib.IMAP4.error as error:
        return emit_error("protocol", str(error))
    except Exception as error:  # 兜底：任何未分类异常都要以 JSON 返回
        return emit_error("protocol", f"{type(error).__name__}: {error}")
    finally:
        if imap is not None:
            try:
                imap.logout()
            except Exception:
                pass


if __name__ == "__main__":
    sys.exit(main())
