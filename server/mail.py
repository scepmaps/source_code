"""Outbound email helpers (SMTP). Used for access-request notifications only."""

from __future__ import annotations

import logging
import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

logger = logging.getLogger(__name__)

# Hard-coded notify address — never taken from request body.
DEFAULT_ACCESS_REQUEST_TO = "pol.roty@scep.city"

_HEADER_UNSAFE = re.compile(r"[\r\n\x00]")
_EMAIL_RE = re.compile(r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$")


def sanitize_header(value: str, max_len: int = 200) -> str:
    """Strip CR/LF/NUL so user input cannot inject email headers."""
    cleaned = _HEADER_UNSAFE.sub("", (value or "")).strip()
    return cleaned[:max_len]


def is_valid_email(value: str) -> bool:
    email = sanitize_header(value, 254).lower()
    if not email or len(email) > 254 or email.count("@") != 1:
        return False
    if not _EMAIL_RE.match(email):
        return False
    # parseaddr rejects oddities; local@domain must survive intact
    _, addr = parseaddr(email)
    return addr.lower() == email


def access_request_recipient() -> str:
    configured = sanitize_header(os.getenv("ACCESS_REQUEST_TO", DEFAULT_ACCESS_REQUEST_TO), 254).lower()
    return configured if is_valid_email(configured) else DEFAULT_ACCESS_REQUEST_TO


def smtp_configured() -> bool:
    if os.getenv("SMTP_DRY_RUN", "").strip().lower() in {"1", "true", "yes", "on"}:
        return True
    return bool(os.getenv("SMTP_HOST", "").strip())


def _smtp_settings() -> dict:
    host = os.getenv("SMTP_HOST", "").strip()
    try:
        port = int(os.getenv("SMTP_PORT", "587"))
    except ValueError:
        port = 587
    user = os.getenv("SMTP_USER", "").strip()
    password = os.getenv("SMTP_PASSWORD", "")
    from_addr = sanitize_header(os.getenv("SMTP_FROM", user or access_request_recipient()), 254)
    from_name = sanitize_header(os.getenv("SMTP_FROM_NAME", "SCEPMAPS"), 80)
    use_tls = os.getenv("SMTP_USE_TLS", "true").strip().lower() not in {"0", "false", "no", "off"}
    use_ssl = os.getenv("SMTP_USE_SSL", "").strip().lower() in {"1", "true", "yes", "on"}
    dry_run = os.getenv("SMTP_DRY_RUN", "").strip().lower() in {"1", "true", "yes", "on"}
    return {
        "host": host,
        "port": port,
        "user": user,
        "password": password,
        "from_addr": from_addr,
        "from_name": from_name,
        "use_tls": use_tls,
        "use_ssl": use_ssl,
        "dry_run": dry_run,
    }


def send_access_request_email(
    *,
    subject: str,
    body_text: str,
    reply_to: str,
) -> None:
    """
    Send access-request notification to the fixed recipient only.

    Raises ValueError for bad input, RuntimeError for SMTP misconfig/failure.
    Never accepts a caller-controlled To/Cc/Bcc.
    """
    to_addr = access_request_recipient()
    reply = sanitize_header(reply_to, 254).lower()
    if not is_valid_email(reply):
        raise ValueError("Invalid reply-to email")

    safe_subject = sanitize_header(subject, 180) or "Access request"
    # Body is plain text only — no HTML to reduce phishing/injection surface.
    safe_body = (body_text or "").replace("\x00", "")[:20000]

    settings = _smtp_settings()
    msg = EmailMessage()
    msg["Subject"] = safe_subject
    msg["From"] = formataddr((settings["from_name"], settings["from_addr"]))
    msg["To"] = to_addr
    msg["Reply-To"] = reply
    # Explicitly no Cc/Bcc — this is not a mail relay.
    msg.set_content(safe_body)

    if settings["dry_run"]:
        logger.info(
            "[mail] SMTP_DRY_RUN access-request to=%s reply-to=%s subject=%r\n%s",
            to_addr,
            reply,
            safe_subject,
            safe_body,
        )
        return

    if not settings["host"]:
        raise RuntimeError("SMTP is not configured")

    try:
        if settings["use_ssl"]:
            context = ssl.create_default_context()
            with smtplib.SMTP_SSL(settings["host"], settings["port"], timeout=20, context=context) as smtp:
                if settings["user"]:
                    smtp.login(settings["user"], settings["password"])
                smtp.send_message(msg)
        else:
            with smtplib.SMTP(settings["host"], settings["port"], timeout=20) as smtp:
                smtp.ehlo()
                if settings["use_tls"]:
                    context = ssl.create_default_context()
                    smtp.starttls(context=context)
                    smtp.ehlo()
                if settings["user"]:
                    smtp.login(settings["user"], settings["password"])
                smtp.send_message(msg)
    except Exception as exc:
        logger.exception("[mail] Failed to send access-request email")
        raise RuntimeError("Failed to send email") from exc
