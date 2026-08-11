"""Outbound email helpers (SMTP). Access-request notify + account approval welcome."""

from __future__ import annotations

import logging
import os
import re
import smtplib
import ssl
from email.message import EmailMessage
from email.utils import formataddr, parseaddr

logger = logging.getLogger(__name__)

# Hard-coded notify addresses — never taken from request body.
# ACCESS_REQUEST_TO may be a comma-separated list; invalid entries are dropped.
DEFAULT_ACCESS_REQUEST_RECIPIENTS = (
    "pol.roty@scep.city",
    "joseph.vittoz@scep.city",
)
DEFAULT_ACCESS_REQUEST_TO = ",".join(DEFAULT_ACCESS_REQUEST_RECIPIENTS)
DEFAULT_PUBLIC_APP_URL = "https://app.scep.city"

_HEADER_UNSAFE = re.compile(r"[\r\n\x00]")
_EMAIL_RE = re.compile(
    r"^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?"
    r"(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$"
)


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
    _, addr = parseaddr(email)
    return addr.lower() == email


def access_request_recipients() -> list[str]:
    """Fixed notify list for access-request emails (comma-separated env or defaults)."""
    raw = os.getenv("ACCESS_REQUEST_TO", DEFAULT_ACCESS_REQUEST_TO)
    # Allow comma-separated lists; keep sanitizer per-address (not the whole string).
    parts = [sanitize_header(p, 254).lower() for p in (raw or "").split(",")]
    recipients: list[str] = []
    for email in parts:
        if email and is_valid_email(email) and email not in recipients:
            recipients.append(email)
    if recipients:
        return recipients
    return list(DEFAULT_ACCESS_REQUEST_RECIPIENTS)


def access_request_recipient() -> str:
    """Primary notify address (first in the list) — used for From fallback / Reply-To."""
    return access_request_recipients()[0]


def public_app_url() -> str:
    raw = (os.getenv("APP_PUBLIC_URL") or DEFAULT_PUBLIC_APP_URL).strip().rstrip("/")
    return raw or DEFAULT_PUBLIC_APP_URL


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


def _send_message(
    *,
    to_addr: str,
    subject: str,
    body_text: str,
    reply_to: str | None = None,
    dry_run_log_body: str | None = None,
) -> None:
    """
    Low-level send. `to_addr` must already be validated.
    dry_run_log_body: optional redacted body for logs (never log secrets).
    """
    if not is_valid_email(to_addr):
        raise ValueError("Invalid recipient email")

    safe_subject = sanitize_header(subject, 180) or "SCEPMAPS"
    safe_body = (body_text or "").replace("\x00", "")[:20000]
    settings = _smtp_settings()

    msg = EmailMessage()
    msg["Subject"] = safe_subject
    msg["From"] = formataddr((settings["from_name"], settings["from_addr"]))
    msg["To"] = to_addr.lower()
    if reply_to:
        reply = sanitize_header(reply_to, 254).lower()
        if is_valid_email(reply):
            msg["Reply-To"] = reply
    msg.set_content(safe_body)

    if settings["dry_run"]:
        logger.info(
            "[mail] SMTP_DRY_RUN to=%s subject=%r\n%s",
            to_addr.lower(),
            safe_subject,
            dry_run_log_body if dry_run_log_body is not None else safe_body,
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
        logger.exception("[mail] Failed to send email to=%s subject=%r", to_addr.lower(), safe_subject)
        raise RuntimeError("Failed to send email") from exc


def send_access_request_email(
    *,
    subject: str,
    body_text: str,
    reply_to: str,
) -> None:
    """
    Send access-request notification to the fixed recipient list only.
    Never accepts a caller-controlled To/Cc/Bcc.
    """
    reply = sanitize_header(reply_to, 254).lower()
    if not is_valid_email(reply):
        raise ValueError("Invalid reply-to email")
    recipients = access_request_recipients()
    errors: list[str] = []
    for to_addr in recipients:
        try:
            _send_message(
                to_addr=to_addr,
                subject=subject,
                body_text=body_text,
                reply_to=reply,
            )
        except Exception as exc:
            errors.append(f"{to_addr}: {exc}")
            logger.exception("[mail] access-request notify failed to=%s", to_addr)
    if errors and len(errors) == len(recipients):
        raise RuntimeError("Failed to send access-request email to all recipients")


def send_account_approved_email(
    *,
    to_email: str,
    name: str,
    temporary_password: str,
) -> None:
    """
    Welcome email with temporary credentials.

    Security notes:
    - Email is not a perfect secret channel; recipients are told to change the password ASAP.
    - The plaintext password is never written to application logs (including SMTP_DRY_RUN).
    """
    to_addr = sanitize_header(to_email, 254).lower()
    if not is_valid_email(to_addr):
        raise ValueError("Invalid recipient email")

    display_name = sanitize_header(name, 120) or "there"
    first_name = display_name.split()[0] if display_name and display_name != "there" else display_name
    login_url = f"{public_app_url()}/login.html"
    # Prefer Joseph as the human reply contact for welcome emails.
    joseph = "joseph.vittoz@scep.city"
    reply_contact = joseph if is_valid_email(joseph) else access_request_recipient()
    # Password may contain special chars — keep as-is in body (not headers).
    password = (temporary_password or "").replace("\x00", "")[:200]
    if len(password) < 6:
        raise ValueError("Password too short to send")

    subject = "Welcome to SCEPMAPS — your account is ready"
    body = (
        f"Hi {first_name},\n\n"
        f"Great news — your SCEPMAPS access request has been approved, "
        f"and I'm really glad to have you on board.\n\n"
        f"You can sign in here:\n"
        f"  {login_url}\n\n"
        f"Your login details:\n"
        f"  Email: {to_addr}\n"
        f"  Temporary password: {password}\n\n"
        f"For security, please change this password as soon as you're in "
        f"(Settings → Change Password).\n\n"
        f"If you have any questions — how something works, what maps or tools "
        f"you need, or anything else — just reply to this email. I'm happy to "
        f"help and always open to a quick exchange.\n\n"
        f"Looking forward to hearing how you get on.\n\n"
        f"Best regards,\n"
        f"Joseph\n"
        f"{reply_contact}\n"
    )
    redacted_body = body.replace(password, "[REDACTED]")

    _send_message(
        to_addr=to_addr,
        subject=subject,
        body_text=body,
        reply_to=reply_contact,
        dry_run_log_body=redacted_body,
    )
