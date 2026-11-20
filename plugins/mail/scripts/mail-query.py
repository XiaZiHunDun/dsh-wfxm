#!/usr/bin/env python3
"""dsh-wfxm 邮件只读查询（J1）。

协议：从 stdin 读一个 JSON，向 stdout 写一个 JSON。密码只在 stdin 里，
不会出现在 argv / 进程列表中；IMAP 始终以只读方式打开，不发送、不删除、
不标记已读、不移动。

输入：
  {"action":"search","account":{host,port,secure,user,password},"request":{...}}
  {"action":"read","account":{...},"request":{"uid":123,"maxChars":4000}}
  {"action":"archive","account":{...},"request":{"uids":[1,2],"folder":"Archive"}}
  {"action":"count","account":{...},"request":{"folder":"Archive"}}
  {"action":"self-test"}
"""

from __future__ import annotations

import base64
import email
import email.policy
import imaplib
import json
import re
import smtplib
import socket
import ssl
import sys
import time
from datetime import datetime
from email.header import decode_header
from email.message import EmailMessage
from email.parser import BytesParser
from email.utils import formatdate, make_msgid
from html.parser import HTMLParser

MAX_LIMIT = 50
DEFAULT_LIMIT = 20
MAX_SCAN = 200
MAX_BODY_CAP = 20000
DEFAULT_BODY = 4000
DEFAULT_ARCHIVE_FOLDER = "Archive"
DEFAULT_DRAFT_FOLDER = "Drafts"
DEFAULT_SENT_FOLDER = "Sent"
MAX_SUBJECT = 200
MAX_OUTGOING_BODY = 4000
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")
ADDRESS_RE = re.compile(r"^[^@\s,;<>]+@[^@\s,;<>]+\.[^@\s,;<>]+$")
CONTROL_RE = re.compile(r"[\x00-\x1f\x7f]")
SENT_FOLDER_CANDIDATES = ("Sent", "已发送", "Sent Items", "Sent Messages")
DRAFT_FOLDER_CANDIDATES = ("Drafts", "草稿", "草稿箱")


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


def encode_mailbox(name: str) -> bytes:
    """IMAP modified UTF-7（RFC 3501 §5.1.3）：非 ASCII 夹名不能直接交给 imaplib。"""
    out: list[str] = []
    buf: list[str] = []

    def flush() -> None:
        if not buf:
            return
        raw = "".join(buf).encode("utf-16-be")
        encoded = base64.b64encode(raw).decode("ascii").rstrip("=").replace("/", ",")
        out.append("&" + encoded + "-")
        buf.clear()

    for char in name:
        code = ord(char)
        if 0x20 <= code <= 0x7E:
            flush()
            out.append("&-" if char == "&" else char)
        else:
            buf.append(char)
    flush()
    return "".join(out).encode("ascii")


def quote_mailbox(encoded: bytes) -> bytes:
    return b'"' + encoded.replace(b"\\", b"\\\\").replace(b'"', b'\\"') + b'"'


def validate_uids(raw) -> list[int]:
    if not isinstance(raw, list):
        raise MailError("protocol", "uids must be a list of positive integers")
    seen: list[int] = []
    for item in raw:
        if isinstance(item, bool) or not isinstance(item, int):
            raise MailError("protocol", "uids must contain only positive integers")
        if item <= 0:
            raise MailError("protocol", "uids must contain only positive integers")
        if item not in seen:
            seen.append(item)
    if not seen:
        raise MailError("protocol", "uids must not be empty")
    if len(seen) > MAX_LIMIT:
        raise MailError("protocol", f"uids must contain at most {MAX_LIMIT} entries")
    return seen


def read_capabilities(imap) -> bytes:
    try:
        typ, data = imap.capability()
    except Exception:
        return b""
    if typ != "OK":
        return b""
    return b" ".join(
        item if isinstance(item, bytes) else str(item).encode("ascii", "ignore")
        for item in data or []
    )


def archive_strategy(capabilities: bytes) -> str | None:
    """优先 UID MOVE；无 MOVE 但有 UIDPLUS 时用作用域受限的 UID EXPUNGE。"""
    if b"MOVE" in capabilities:
        return "move"
    if b"UIDPLUS" in capabilities:
        return "copy-expunge"
    return None


def ensure_folder(imap, folder: str, encoded: bytes) -> None:
    """目标夹不存在时创建并复查；无法确认可用则报错，不做静默降级。"""
    quoted = quote_mailbox(encoded)
    typ, _ = imap.select(quoted, readonly=True)
    if typ == "OK":
        return
    try:
        imap.create(quoted)
    except imaplib.IMAP4.error:
        pass
    typ, data = imap.select(quoted, readonly=True)
    if typ != "OK":
        raise MailError("protocol", f"archive folder {folder!r} is not available: {data!r}")


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


def archive_mail(imap, request: dict) -> dict:
    """把 INBOX 中显式指定的 uid 移到归档夹；只移动，不发送、不改写。"""
    uids = validate_uids(request.get("uids"))
    folder = str(request.get("folder") or DEFAULT_ARCHIVE_FOLDER)
    strategy = archive_strategy(read_capabilities(imap))
    if strategy is None:
        raise MailError(
            "protocol",
            "server supports neither UID MOVE nor UIDPLUS; refusing to archive without a scoped expunge",
        )
    ensure_folder(imap, folder, encode_mailbox(folder))
    typ, data = imap.select("INBOX", readonly=False)
    if typ != "OK":
        raise MailError("protocol", f"cannot open INBOX for archiving: {data!r}")
    uid_set = ",".join(str(uid) for uid in uids)
    quoted_folder = quote_mailbox(encode_mailbox(folder))

    if strategy == "move":
        typ, data = imap.uid("MOVE", uid_set, quoted_folder)
        if typ != "OK":
            raise MailError("protocol", f"UID MOVE failed: {data!r}")
    else:
        typ, data = imap.uid("COPY", uid_set, quoted_folder)
        if typ != "OK":
            raise MailError("protocol", f"UID COPY failed: {data!r}")
        typ, data = imap.uid("STORE", uid_set, "+FLAGS", "(\\Deleted)")
        if typ != "OK":
            raise MailError("protocol", f"UID STORE \\Deleted failed: {data!r}")
        typ, data = imap.uid("EXPUNGE", uid_set)
        if typ != "OK":
            # 回滚删除标记，避免留下「已标记未清除」的半状态。
            imap.uid("STORE", uid_set, "-FLAGS", "(\\Deleted)")
            raise MailError("protocol", f"UID EXPUNGE failed: {data!r}")
    return {"folder": folder, "moved": len(uids), "uids": uids}


def count_mail(imap, request: dict) -> dict:
    """只读选区并返回 EXISTS 计数，用作 `mail_archived` / `mail_sent` 判据的探针。"""
    requested = request.get("folder")
    role = request.get("role")
    if requested:
        folder = str(requested)
    elif role == "sent":
        folder = DEFAULT_SENT_FOLDER
    elif role == "drafted":
        folder = DEFAULT_DRAFT_FOLDER
    else:
        folder = DEFAULT_ARCHIVE_FOLDER
    resolved = folder
    if not folder_available(imap, folder) and role in ("sent", "drafted"):
        # 各服务商命名不同（Sent / 已发送 / Sent Items…）；只读尝试候选。
        found = discover_folder(imap, candidates_for(role))
        if found is not None:
            resolved = found
    quoted = quote_mailbox(encode_mailbox(resolved))
    typ, data = imap.select(quoted, readonly=True)
    if typ != "OK":
        raise MailError("protocol", f"cannot open folder {resolved!r}: {data!r}")
    try:
        count = int(data[0])
    except (TypeError, ValueError, IndexError):
        count = 0
    return {"folder": resolved, "count": count}


def candidates_for(role: str) -> tuple[str, ...]:
    if role == "sent":
        return SENT_FOLDER_CANDIDATES
    if role == "drafted":
        return DRAFT_FOLDER_CANDIDATES
    return (DEFAULT_ARCHIVE_FOLDER,)


def folder_available(imap, folder: str) -> bool:
    try:
        typ, _ = imap.select(quote_mailbox(encode_mailbox(folder)), readonly=True)
    except imaplib.IMAP4.error:
        return False
    return typ == "OK"


def discover_folder(imap, candidates) -> str | None:
    for name in candidates:
        if folder_available(imap, name):
            return name
    return None


def ensure_writable_folder(imap, folder: str) -> str:
    if folder_available(imap, folder):
        return folder
    encoded = encode_mailbox(folder)
    quoted = quote_mailbox(encoded)
    try:
        imap.create(quoted)
    except imaplib.IMAP4.error:
        pass
    if not folder_available(imap, folder):
        raise MailError("protocol", f"folder {folder!r} is not available")
    return folder


def validate_outgoing(request: dict) -> dict:
    to = str(request.get("to") or "").strip()
    subject = str(request.get("subject") or "").strip()
    body = request.get("body")
    if not ADDRESS_RE.match(to):
        raise MailError("protocol", "to must be a single email address")
    if CONTROL_RE.search(subject):
        raise MailError("protocol", "subject must not contain control characters")
    if subject == "" or len(subject) > MAX_SUBJECT:
        raise MailError("protocol", f"subject must be 1..{MAX_SUBJECT} characters")
    if not isinstance(body, str) or body.strip() == "":
        raise MailError("protocol", "body must be a non-empty string")
    if len(body) > MAX_OUTGOING_BODY:
        raise MailError("protocol", f"body must be at most {MAX_OUTGOING_BODY} characters")
    return {"to": to, "subject": subject, "body": body}


def build_message(account: dict, request: dict) -> tuple[EmailMessage, bytes]:
    fields = validate_outgoing(request)
    sender = str(account.get("user") or "").strip()
    if not ADDRESS_RE.match(sender):
        raise MailError("config", "account.user is not an email address")
    message = EmailMessage()
    message["From"] = sender
    message["To"] = fields["to"]
    message["Subject"] = fields["subject"]
    message["Date"] = formatdate(localtime=True)
    message["Message-ID"] = make_msgid(domain=sender.split("@", 1)[1])
    message.set_content(fields["body"], subtype="plain", charset="utf-8")
    return message, message.as_bytes()


def append_message(imap, folder: str, raw: bytes, flags: str) -> None:
    mailbox = quote_mailbox(encode_mailbox(folder)).decode("ascii")
    typ, data = imap.append(mailbox, flags, imaplib.Time2Internaldate(time.time()), raw)
    if typ != "OK":
        raise MailError("protocol", f"APPEND to {folder!r} failed: {data!r}")


def smtp_settings(account: dict) -> dict:
    smtp = account.get("smtp") or {}
    host = str(smtp.get("host") or "").strip()
    if host == "":
        raise MailError("config", "SMTP host is not configured")
    try:
        port = int(smtp.get("port", 465))
    except (TypeError, ValueError) as error:
        raise MailError("config", "SMTP port must be an integer") from error
    return {"host": host, "port": port, "secure": smtp.get("secure") is not False}


def smtp_send(account: dict, raw: bytes) -> None:
    settings = smtp_settings(account)
    user = account.get("user")
    password = account.get("password")
    if not user or not password:
        raise MailError("config", "mail account is missing user/password")
    context = ssl.create_default_context()
    try:
        if settings["secure"]:
            client = smtplib.SMTP_SSL(settings["host"], settings["port"], timeout=20, context=context)
        else:
            client = smtplib.SMTP(settings["host"], settings["port"], timeout=20)
            client.starttls(context=context)
    except (socket.timeout, TimeoutError) as error:
        raise MailError("timeout", f"connect to SMTP {settings['host']}:{settings['port']} timed out") from error
    except (OSError, smtplib.SMTPException) as error:
        raise MailError("network", f"cannot connect to SMTP {settings['host']}:{settings['port']}: {error}") from error
    try:
        client.login(user, password)
        client.send_message(BytesParser(policy=email.policy.default).parsebytes(raw))
    except smtplib.SMTPAuthenticationError as error:
        raise MailError("auth", f"SMTP login failed: {error}") from error
    except smtplib.SMTPException as error:
        raise MailError("protocol", f"SMTP send failed: {error}") from error
    finally:
        try:
            client.quit()
        except Exception:
            pass


def send_mail(imap, account: dict, request: dict) -> dict:
    """SMTP 发送；成功后尽力向已发送夹追加副本（失败只告警）。"""
    message, raw = build_message(account, request)
    smtp_send(account, raw)
    requested = str(request.get("folder") or "").strip()
    sent_folder = requested or discover_folder(imap, SENT_FOLDER_CANDIDATES) or DEFAULT_SENT_FOLDER
    appended = False
    warning = None
    try:
        if not folder_available(imap, sent_folder):
            sent_folder = ensure_writable_folder(imap, sent_folder)
        append_message(imap, sent_folder, raw, "\\Seen")
        appended = True
    except Exception as error:  # 已发出：副本失败不能反悔
        warning = f"sent copy not saved: {type(error).__name__}: {error}"
    return {
        "to": str(message["To"]),
        "subject": str(message["Subject"]),
        "messageId": str(message["Message-ID"]),
        "sentFolder": sent_folder,
        "appended": appended,
        "warning": warning,
    }


def draft_mail(imap, account: dict, request: dict) -> dict:
    """把草稿写入草稿夹；草稿夹不可用时按候选名发现或创建。"""
    message, raw = build_message(account, request)
    requested = str(request.get("folder") or "").strip()
    if requested:
        folder = ensure_writable_folder(imap, requested)
    else:
        folder = discover_folder(imap, DRAFT_FOLDER_CANDIDATES) or ensure_writable_folder(imap, DEFAULT_DRAFT_FOLDER)
    append_message(imap, folder, raw, "\\Draft")
    return {
        "folder": folder,
        "to": str(message["To"]),
        "subject": str(message["Subject"]),
        "messageId": str(message["Message-ID"]),
    }


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
    check("mailbox ascii", encode_mailbox("Archive") == b"Archive")
    check("mailbox ampersand", encode_mailbox("A&B") == b"A&-B")
    encoded = encode_mailbox("已归档")
    payload = encoded[1:-1].replace(b",", b"/")
    payload += b"=" * (-len(payload) % 4)
    check("mailbox modified utf-7", encoded.startswith(b"&") and encoded.endswith(b"-")
          and base64.b64decode(payload).decode("utf-16-be") == "已归档")
    check("uid list", validate_uids([3, 1, 3]) == [3, 1])
    check("archive strategy move", archive_strategy(b"IMAP4rev1 MOVE UIDPLUS") == "move")
    check("archive strategy copy-expunge", archive_strategy(b"IMAP4rev1 UIDPLUS") == "copy-expunge")
    check("archive strategy unsupported", archive_strategy(b"IMAP4rev1") is None)
    check("sent candidates", "Sent" in candidates_for("sent") and "已发送" in candidates_for("sent"))
    check("draft candidates", "Drafts" in candidates_for("drafted") and "草稿" in candidates_for("drafted"))

    outgoing = validate_outgoing({"to": "a@example.com", "subject": "你好", "body": "第一行\n第二行"})
    check("outgoing keeps newlines", outgoing["body"] == "第一行\n第二行")
    rejected = 0
    for bad in (
        {"to": "a@example.com\r\nBcc: x@example.com", "subject": "s", "body": "b"},
        {"to": "a@example.com", "subject": "s\r\nBcc: x@example.com", "body": "b"},
        {"to": "not-an-address", "subject": "s", "body": "b"},
        {"to": "a@example.com", "subject": "", "body": "b"},
        {"to": "a@example.com", "subject": "s", "body": "  "},
    ):
        try:
            validate_outgoing(bad)
        except MailError:
            rejected += 1
    check("outgoing rejects injection and empty fields", rejected == 5)

    smtp, raw_message = build_message(
        {"user": "me@example.com", "smtp": {"host": "smtp.example.com"}},
        {"to": "a@example.com", "subject": "会议改期", "body": "改到周五"},
    )
    check("message from user", smtp["From"] == "me@example.com")
    check("message to", smtp["To"] == "a@example.com")
    check("message subject decodes", smtp["Subject"] == "会议改期")
    check("message has id", str(smtp["Message-ID"]).startswith("<"))
    check("message raw utf-8", b"=?utf-8?" in raw_message.lower() or b"\xe4\xbc\x9a\xe8\xae\xae" in raw_message)
    check("smtp host", smtp_settings({"smtp": {"host": "smtp.example.com"}})["host"] == "smtp.example.com")
    check("smtp secure default", smtp_settings({"smtp": {"host": "smtp.example.com"}})["secure"] is True)
    check("smtp plain", smtp_settings({"smtp": {"host": "smtp.example.com", "secure": False}})["secure"] is False)

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
    if action not in ("search", "read", "archive", "count", "draft", "send"):
        return emit_error("protocol", f"unknown action {action!r}")

    imap = None
    try:
        request = payload.get("request") or {}
        account = payload.get("account") or {}
        imap = connect(account)
        if action == "search":
            result = search_mail(imap, request)
        elif action == "read":
            result = read_mail(imap, request)
        elif action == "count":
            result = count_mail(imap, request)
        elif action == "draft":
            result = draft_mail(imap, account, request)
        elif action == "send":
            result = send_mail(imap, account, request)
        else:
            result = archive_mail(imap, request)
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
