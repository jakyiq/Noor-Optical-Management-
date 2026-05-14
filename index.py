"""
Noor Optical Clinic SaaS — Flask Backend
app.py — All routes, session auth, Supabase DB
"""

import os
import json
import bcrypt
import traceback
import logging
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timedelta, date
from functools import wraps

from flask import Flask, request, jsonify, session
from flask_cors import CORS
from flask_limiter import Limiter
from flask_limiter.util import get_remote_address
from supabase import create_client, Client

_log_level = logging.DEBUG if os.environ.get("FLASK_DEBUG") else logging.WARNING
logging.basicConfig(level=_log_level)

# ─────────────────────────────────────────────
# APP INIT
# ─────────────────────────────────────────────
app = Flask(__name__)
FLASK_SECRET_KEY = os.environ.get("FLASK_SECRET_KEY", "")
if not FLASK_SECRET_KEY:
    raise RuntimeError("FLASK_SECRET_KEY must be set as an environment variable.")
app.secret_key = FLASK_SECRET_KEY
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "None"   # Required for cross-origin on Vercel
app.config["SESSION_COOKIE_SECURE"] = True        # Required when SameSite=None
app.config["PERMANENT_SESSION_LIFETIME"] = timedelta(hours=8)

# Allow the frontend to send cookies cross-origin on Vercel.
# Set CORS_ORIGINS env var to a comma-separated list of allowed origins.
_cors_origins_env = os.environ.get("CORS_ORIGINS", "")
_cors_origins = [o.strip() for o in _cors_origins_env.split(",") if o.strip()] or [
    "http://localhost:5000",
    "http://127.0.0.1:5000",
    "http://tauri.localhost",
    "tauri://localhost",
]
CORS(app, supports_credentials=True, origins=_cors_origins)

def _rate_limit_storage_uri():
    storage_uri = os.environ.get("RATELIMIT_STORAGE_URI")
    is_production = os.environ.get("VERCEL") or os.environ.get("FLASK_ENV") == "production"
    if is_production and not storage_uri:
        raise RuntimeError(
            "RATELIMIT_STORAGE_URI must be set in production. "
            "Use Redis/Upstash; memory:// resets on Vercel cold starts."
        )
    return storage_uri or "memory://"

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["300 per hour"],
    # IMPORTANT: set RATELIMIT_STORAGE_URI to a Redis/Upstash URL in production.
    # "memory://" resets on every cold start — rate limits won't work on Vercel otherwise.
    storage_uri=_rate_limit_storage_uri(),
)

# The public URL of this app — used as redirect_to in Supabase auth emails
# so confirmation / reset links point to your domain, not localhost.
# Set this in Vercel: Project Settings → Environment Variables → SITE_URL
# Example: https://noor.yourapp.com
SITE_URL = os.environ.get("SITE_URL", "").rstrip("/")

# ─────────────────────────────────────────────
# SUPABASE CLIENT  (service_role key — backend only)
# ─────────────────────────────────────────────
SUPABASE_URL = os.environ.get("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.environ.get("SUPABASE_SERVICE_KEY", "")  # NEVER expose to frontend

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    raise RuntimeError(
        "SUPABASE_URL and SUPABASE_SERVICE_KEY must be set as environment variables. "
        "Add them in Vercel: Project Settings → Environment Variables."
    )

db: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)


# ─────────────────────────────────────────────
# HELPERS
# ─────────────────────────────────────────────
def now_iso():
    return datetime.utcnow().isoformat() + "Z"

def _parse_iso(ts):
    """Parse an ISO-8601 datetime string robustly across Python versions.
    Handles both 'Z' suffix (our format) and '+00:00' offset."""
    if not ts:
        return None
    return datetime.fromisoformat(ts.replace("Z", "+00:00"))

def today_str():
    return date.today().isoformat()

def err(msg, code=400, **extra):
    payload = {"error": msg}
    payload.update(extra)
    return jsonify(payload), code

def ok(data=None, **kwargs):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)


DEFAULT_LENS_CATALOG = {
    "type": [
        ("single_vision", "Single Vision"),
        ("bifocal", "Bifocal"),
        ("trifocal", "Trifocal"),
        ("progressive", "Progressive"),
        ("reading", "Reading"),
        ("plano", "Plano"),
        ("prism", "Prism"),
        ("occupational", "Occupational"),
    ],
    "material": [
        ("plastic", "Plastic (CR-39)"),
        ("polycarbonate", "Polycarbonate"),
        ("high_index_16", "High-Index 1.6"),
        ("high_index_167", "High-Index 1.67"),
        ("high_index_174", "High-Index 1.74"),
        ("trivex", "Trivex"),
        ("glass", "Glass"),
        ("contact", "Contact"),
    ],
    "coating": [
        ("clear", "Clear"),
        ("blue_cut", "Blue Cut"),
        ("green_cut", "Green Cut"),
        ("photochromic", "Photochromic"),
        ("photo_blue", "Photochromic Blue"),
        ("photo_green", "Photochromic Green"),
        ("polarized", "Polarized"),
        ("anti_reflective", "Anti-Reflective (AR)"),
        ("tinted", "Tinted"),
        ("uv400", "UV400"),
        ("mirror", "Mirror"),
        ("anti_scratch", "Anti-Scratch"),
        ("anti_fog", "Anti-Fog"),
        ("oleophobic", "Oleophobic"),
        ("combo_ar_bc", "AR + Blue Cut Combo"),
    ],
}


def _slugify_lens_value(value):
    raw = (value or "").strip().lower()
    out = []
    prev_us = False
    for ch in raw:
        if ch.isalnum():
            out.append(ch)
            prev_us = False
        elif not prev_us:
            out.append("_")
            prev_us = True
    return "".join(out).strip("_") or "custom"


def _num_or_zero(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def _safe_license_summary(license_state):
    status = license_state["status"]
    plan   = license_state.get("plan")
    return {
        "status": status,
        "plan": plan,
        "days_left": license_state.get("days_left"),
        "read_only": status in ("expired_read_only", "blocked"),
        # exports are allowed only on paid active plans — not trial, not expired
        "exports_allowed": status == "active" and plan != "trial",
    }


def _extract_auth_user_id(auth_result):
    user = getattr(auth_result, "user", None)
    if user is None and isinstance(auth_result, dict):
        user = auth_result.get("user")
    if user is None:
        return None
    if isinstance(user, dict):
        return user.get("id")
    return getattr(user, "id", None)


def _auth_rest(path, payload, query=""):
    url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/{path}{query}"
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        raise RuntimeError(detail or str(exc)) from exc


def _clinic_is_banned(clinic_id):
    if not clinic_id:
        return False
    res = db.table("clinics").select("is_banned").eq("id", clinic_id).limit(1).execute()
    row = res.data[0] if res.data else None
    return bool(row and row.get("is_banned"))


def _license_state(clinic_id):
    """
    Backend-only license decision.
    status values: active, trial, expired_read_only, blocked.
    """
    res = db.table("licenses") \
        .select("*") \
        .eq("clinic_id", clinic_id) \
        .eq("is_active", True) \
        .order("created_at", desc=True) \
        .limit(1) \
        .execute()

    if not res.data:
        return {"status": "blocked", "plan": None, "days_left": None}

    lic = res.data[0]
    plan = lic.get("plan")

    # Lifetime never expires and has full paid capabilities.
    if plan == "lifetime" or lic.get("expires_at") is None:
        return {"status": "active", "plan": plan, "days_left": None}

    expires = date.fromisoformat(lic["expires_at"])
    today = date.today()
    delta = (expires - today).days

    if delta >= 0:
        # "custom" is a paid plan variant — treat same as active
        status = "trial" if plan == "trial" else "active"
        return {"status": status, "plan": plan, "days_left": delta}

    # Expired clinics keep read access only. No write grace period.
    return {"status": "expired_read_only", "plan": plan, "days_left": delta}


@app.before_request
def _csrf_protect():
    if request.method not in WRITE_METHODS:
        return None
    # Strip blueprint prefix (e.g. "sync.sync_item" → "sync_item") so the
    # exemption list works for both plain routes and blueprint-registered routes.
    endpoint = (request.endpoint or "").split(".")[-1]
    if endpoint in {"login", "signup", "reset_password"}:
        return None
    if "user_id" not in session:
        return None

    expected = session.get("csrf_token")
    provided = request.headers.get("X-CSRF-Token")
    if not expected or not provided or not secrets.compare_digest(expected, provided):
        return err("CSRF token missing or invalid", 403)
    return None

def _write_audit(clinic_id, user_id, action, entity_type, entity_id=None,
                 old_value=None, new_value=None):
    def _jsonable(v):
        if v is None:
            return None
        if isinstance(v, (dict, list)):
            return json.loads(json.dumps(v, default=str))
        return v

    try:
        db.table("audit_log").insert({
            "clinic_id":   clinic_id,
            "user_id":     user_id,
            "action":      action,
            "entity_type": entity_type,
            "entity_id":   entity_id,
            "old_value":   _jsonable(old_value),
            "new_value":   _jsonable(new_value),
            "created_at":  now_iso(),
        }).execute()
    except Exception:
        logging.warning("audit_log write failed", exc_info=True)


# ─────────────────────────────────────────────
# AUTH DECORATOR
# ─────────────────────────────────────────────
def _auth(roles=None, setting=None, export=False, allow_readonly_write=False):
    """
    Decorator that:
    1. Validates session exists and is not expired
    2. Checks license/read-only/export state
    3. Optionally restricts to specific roles
    4. Optionally checks a clinic_settings permission key (for receptionist gating)

    Usage:
        @app.route(...)
        @_auth()                             # any logged-in user
        @_auth(roles=["doctor","super_admin"])
        @_auth(roles=["receptionist"], setting="recept_view_patients")
    """
    def decorator(f):
        @wraps(f)
        def wrapper(*args, **kwargs):
            # 1. Session check
            if "user_id" not in session:
                return err("Unauthorized", 401)

            expires_at = session.get("expires_at")
            parsed_expiry = _parse_iso(expires_at)
            if parsed_expiry and parsed_expiry.replace(tzinfo=None) < datetime.utcnow():
                session.clear()
                return err("Session expired", 401)

            role = session.get("role")
            clinic_id = session.get("clinic_id")

            # Strip blueprint prefix (e.g. "sync.sync_item" → "sync_item") so
            # blueprint routes aren't blocked when the user is on the change-password page.
            _endpoint = (request.endpoint or '').split('.')[-1]
            if session.get("must_change_password") and _endpoint != "change_password":
                return err("Password change required", 403)

            # Super admin bypasses license and permission checks
            if role == "super_admin":
                return f(*args, **kwargs)

            if _clinic_is_banned(clinic_id):
                session.clear()
                return err("Clinic account is banned. Please contact support.", 403)

            # 2. License check
            license_state = _license_state(clinic_id)
            status = license_state["status"]
            if status == "blocked":
                return err("License blocked. Please contact support.", 403)
            if export and status in ("trial", "expired_read_only", "blocked"):
                return err("هذه الميزة متاحة للاشتراكات المدفوعة فقط. يرجى الترقية للوصول إلى التصدير. | This feature is available on paid plans only. Please upgrade to enable exports.", 403)
            if (
                status == "expired_read_only"
                and request.method in WRITE_METHODS
                and not allow_readonly_write
            ):
                return err("License expired. Clinic is read-only until activated.", 403)

            # 3. Role check
            if roles and role not in roles:
                return err("Forbidden", 403)

            # 4. Per-feature receptionist permission check
            if setting and role == "receptionist":
                try:
                    cs_res = db.table("clinic_settings") \
                        .select(setting) \
                        .eq("clinic_id", clinic_id) \
                        .limit(1) \
                        .execute()
                    cs_row = cs_res.data[0] if cs_res.data else None
                    if not cs_row or not cs_row.get(setting):
                        return err("Permission denied", 403)
                except Exception:
                    # clinic_settings row missing — deny access rather than crash
                    logging.warning(
                        "clinic_settings row missing for clinic_id=%s, "
                        "denying receptionist access to setting=%s",
                        clinic_id, setting
                    )
                    return err("Clinic settings not configured. Contact your administrator.", 403)

            return f(*args, **kwargs)
        return wrapper
    return decorator


# ─────────────────────────────────────────────────────────────
# AUTH ROUTES
# ─────────────────────────────────────────────────────────────

@app.route("/api/login", methods=["POST"])
@limiter.limit("5 per minute; 20 per hour")
def login():
    body = request.get_json() or {}
    username = (body.get("username") or body.get("email") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return err("Username and password are required")

    user = None
    auth_user_id = None

    # Owner accounts use Supabase Auth. Staff/super-admin username login
    # remains supported during the migration.
    if "@" in username:
        try:
            auth_res = _auth_rest("token", {"email": username, "password": password}, "?grant_type=password")
            auth_user_id = (auth_res.get("user") or {}).get("id")
        except Exception:
            auth_user_id = None

        if auth_user_id:
            res = db.table("users").select("*").eq("auth_user_id", auth_user_id).eq("is_active", True).limit(1).execute()
            if not res.data:
                res = db.table("users").select("*").eq("email", username).eq("is_active", True).limit(1).execute()
            if res.data:
                user = res.data[0]

    if user is None:
        res = db.table("users") \
            .select("*") \
            .eq("username", username) \
            .eq("is_active", True) \
            .limit(1) \
            .execute()

        if not res.data:
            return err("Invalid credentials", 401)

        user = res.data[0]

        if not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
            return err("Invalid credentials", 401)
    role = user["role"]
    clinic_id = user["clinic_id"]

    if role != "super_admin" and _clinic_is_banned(clinic_id):
        return err("Clinic account is banned. Please contact support.", 403)

    # License check (skip for super_admin)
    grace_warning = None
    license_summary = None
    if role != "super_admin":
        license_state = _license_state(clinic_id)
        if license_state["status"] == "blocked":
            return err("License expired. Please contact support.", 403)
        if license_state["status"] == "expired_read_only":
            grace_warning = "License expired. Clinic is read-only until activated."
        license_summary = _safe_license_summary(license_state)

    # Build session — clear first to prevent session fixation
    session.clear()
    session.permanent = True
    session["user_id"]   = user["id"]
    session["role"]      = role
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat() + "Z"
    session["must_change_password"] = bool(user.get("must_change_password", False))
    csrf_token = _csrf_token()

    # For super_admin: if no clinic_id, auto-assign the first clinic or create a default one
    if role == "super_admin" and not clinic_id:
        clinics_res = db.table("clinics").select("id").order("created_at").limit(1).execute()
        if clinics_res.data:
            clinic_id = clinics_res.data[0]["id"]
        else:
            # Create a default clinic for the super admin to work with
            new_clinic = db.table("clinics").insert({
                "name": "عيادة نور البصرية",
                "created_at": now_iso(),
            }).execute()
            clinic_id = new_clinic.data[0]["id"]
            # Create license for it
            db.table("licenses").insert({
                "clinic_id":  clinic_id,
                "plan":       "lifetime",
                "starts_at":  today_str(),
                "expires_at": None,
                "is_active":  True,
            }).execute()
            # Create default clinic_settings
            db.table("clinic_settings").insert({
                "clinic_id":               clinic_id,
                "followup_months_default": 3,
                "recept_view_patients":    True,
                "recept_edit_patients":    True,
                "recept_view_financials":  True,
                "recept_edit_financials":  True,
                "recept_access_inventory": True,
                "recept_export_reports":   True,
                "recept_view_audit":       True,
            }).execute()
        # Bind super_admin to this clinic in DB too
        db.table("users").update({"clinic_id": clinic_id}).eq("id", user["id"]).execute()

    session["clinic_id"] = clinic_id

    # Update last_login
    db.table("users").update({"last_login": now_iso()}).eq("id", user["id"]).execute()

    return ok({
        "user_id":              user["id"],
        "full_name":            user["full_name"],
        "username":             user["username"],
        "role":                 role,
        "clinic_id":            clinic_id,
        "must_change_password": user.get("must_change_password", False),
        "grace_warning":        grace_warning,
        "expires_at":           session.get("expires_at") or None,
        "csrf_token":           csrf_token,
        "license":              license_summary,
    })


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return ok()


@app.route("/api/signup", methods=["POST"])
@limiter.limit("5 per hour")
def signup():
    body = request.get_json() or {}
    clinic_name = (body.get("clinic_name") or "").strip()
    owner_name = (body.get("owner_name") or "").strip()
    email = (body.get("email") or "").strip().lower()
    phone = (body.get("phone") or "").strip()
    password = body.get("password") or ""

    if not clinic_name or not owner_name or not email or len(password) < 8:
        return err("clinic_name, owner_name, email, and an 8+ character password are required")

    existing = db.table("users").select("id").eq("email", email).limit(1).execute()
    if existing.data:
        return err("An account already exists for this email", 409)

    try:
        signup_payload = {"email": email, "password": password}
        # redirect_to ensures the confirmation email links back to your live
        # domain rather than localhost. The frontend handles the token at /?type=signup
        if SITE_URL:
            signup_payload["options"] = {
                "emailRedirectTo": f"{SITE_URL}/?type=signup"
            }
        auth_res = _auth_rest("signup", signup_payload)
        auth_user_id = (auth_res.get("user") or {}).get("id")
    except Exception as exc:
        logging.exception("Supabase signup failed")
        return err(f"Signup failed: {str(exc)}", 400)

    clinic_res = db.table("clinics").insert({
        "name": clinic_name,
        "phone": phone,
        "owner_email": email,
        "owner_auth_user_id": auth_user_id,
        "created_at": now_iso(),
    }).execute()
    clinic = clinic_res.data[0]
    cid = clinic["id"]

    db.table("clinic_settings").insert({
        "clinic_id": cid,
        "followup_months_default": 3,
        "recept_view_patients": True,
        "recept_edit_patients": True,
        "recept_view_financials": False,
        "recept_edit_financials": False,
        "recept_access_inventory": True,
        "recept_export_reports": False,
        "recept_view_audit": False,
        "default_checkup_fee": 0,
        "print_show_financials": True,
    }).execute()

    expires_at = (date.today() + timedelta(days=7)).isoformat()
    db.table("licenses").insert({
        "clinic_id": cid,
        "plan": "trial",
        "starts_at": today_str(),
        "expires_at": expires_at,
        "is_active": True,
        "notes": "Self signup trial",
    }).execute()

    hashed = bcrypt.hashpw(secrets.token_urlsafe(24).encode(), bcrypt.gensalt()).decode()
    db.table("users").insert({
        "clinic_id": cid,
        "username": email,
        "email": email,
        "auth_user_id": auth_user_id,
        "password_hash": hashed,
        "full_name": owner_name,
        "role": "doctor",
        "is_active": True,
        "must_change_password": False,
        "created_at": now_iso(),
    }).execute()

    return ok({"clinic_id": cid, "email": email, "trial_expires_at": expires_at}), 201


@app.route("/api/reset-password", methods=["POST"])
@limiter.limit("5 per hour")
def reset_password():
    body = request.get_json() or {}
    email = (body.get("email") or "").strip().lower()
    if not email:
        return err("email is required")
    try:
        recover_payload = {"email": email}
        # redirect_to ensures the password-reset email links to your live domain.
        # The frontend reads the access_token from the URL hash at /?type=recovery
        # and calls /api/auth/set-new-password to complete the reset.
        if SITE_URL:
            recover_payload["options"] = {
                "redirectTo": f"{SITE_URL}/?type=recovery"
            }
        _auth_rest("recover", recover_payload)
    except Exception:
        logging.exception("Supabase reset password failed")
    return ok({"message": "If the email exists, a reset link has been sent."})


@app.route("/api/auth/confirm", methods=["POST"])
@limiter.limit("10 per hour")
def auth_confirm():
    """
    Exchange a Supabase email-confirmation token for a verified session.
    Called by the frontend when the user lands on /?type=signup&token_hash=...
    Body: { token_hash, type }   (type is usually "signup" or "email")
    """
    body = request.get_json() or {}
    token_hash = (body.get("token_hash") or "").strip()
    otp_type   = (body.get("type") or "signup").strip()

    if not token_hash:
        return err("token_hash is required", 400)

    try:
        res = _auth_rest_get_verify(token_hash, otp_type)
    except Exception as exc:
        logging.warning("auth_confirm failed: %s", exc)
        return err("Invalid or expired confirmation link. Please sign up again.", 400)

    user = res.get("user") or {}
    email = user.get("email")
    if not email:
        return err("Could not verify email address.", 400)

    # Mark the Supabase auth_user_id in our users table so email login works
    auth_uid = user.get("id")
    if auth_uid:
        db.table("users") \
          .update({"auth_user_id": auth_uid}) \
          .eq("email", email) \
          .execute()

    return ok({"message": "Email confirmed. You can now sign in.", "email": email})


def _auth_rest_get_verify(token_hash, otp_type):
    """Call Supabase /auth/v1/verify to exchange a token_hash."""
    url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/verify"
    payload = {"token_hash": token_hash, "type": otp_type}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read().decode("utf-8") or "{}")


@app.route("/api/auth/set-new-password", methods=["POST"])
@limiter.limit("10 per hour")
def auth_set_new_password():
    """
    Complete a password-reset flow.
    The frontend extracts access_token + refresh_token from the URL hash
    (Supabase appends them after the user clicks the reset link), then
    calls this endpoint to update the password.
    Body: { access_token, refresh_token, password }
    """
    body = request.get_json() or {}
    access_token  = (body.get("access_token") or "").strip()
    refresh_token = (body.get("refresh_token") or "").strip()
    new_password  = body.get("password") or ""

    if not access_token or not refresh_token:
        return err("access_token and refresh_token are required", 400)
    if len(new_password) < 8:
        return err("Password must be at least 8 characters", 400)

    # Use the user's own access token to update their password
    url = f"{SUPABASE_URL.rstrip('/')}/auth/v1/user"
    payload = {"password": new_password}
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=data,
        headers={
            "apikey": SUPABASE_SERVICE_KEY,
            "Authorization": f"Bearer {access_token}",
            "Content-Type": "application/json",
        },
        method="PUT",
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            user_data = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="ignore")
        logging.warning("set-new-password Supabase error: %s", detail)
        return err("Reset link is invalid or expired. Please request a new one.", 400)

    email = user_data.get("email")

    # Also update the bcrypt hash in our own users table so username login stays in sync
    if email:
        hashed = bcrypt.hashpw(new_password.encode(), bcrypt.gensalt()).decode()
        db.table("users").update({
            "password_hash": hashed,
            "must_change_password": False,
        }).eq("email", email).execute()

    return ok({"message": "Password updated. You can now sign in."})


@app.route("/api/me", methods=["GET"])
def me():
    if "user_id" not in session:
        return err("Unauthorized", 401)

    expires_at = session.get("expires_at")
    parsed_expiry = _parse_iso(expires_at)
    if parsed_expiry and parsed_expiry.replace(tzinfo=None) < datetime.utcnow():
        session.clear()
        return err("Session expired", 401)

    role = session.get("role")
    clinic_id = session.get("clinic_id")

    grace_warning = None
    license_summary = None
    if role != "super_admin":
        license_state = _license_state(clinic_id)
        if license_state["status"] == "blocked":
            session.clear()
            return err("License expired", 403)
        if license_state["status"] == "expired_read_only":
            grace_warning = "License expired. Clinic is read-only until activated."
        license_summary = _safe_license_summary(license_state)

    # Refresh session expiry
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat() + "Z"

    # Re-fetch full_name from DB so it's always accurate on session restore
    user_row = db.table("users").select("full_name,username").eq("id", session["user_id"]).limit(1).execute()
    _user = user_row.data[0] if user_row.data else {}
    full_name = _user.get("full_name", "")
    username  = _user.get("username", "")

    return ok({
        "user_id":              session["user_id"],
        "clinic_id":            clinic_id,
        "role":                 role,
        "full_name":            full_name,
        "username":             username,
        "must_change_password": bool(session.get("must_change_password", False)),
        "grace_warning":        grace_warning,
        "expires_at":           session.get("expires_at") or None,
        "csrf_token":           _csrf_token(),
        "license":              license_summary,
    })


@app.route("/api/change-password", methods=["POST"])
@_auth(allow_readonly_write=True)
def change_password():
    body = request.get_json() or {}
    new_pw = body.get("password", "")
    if len(new_pw) < 8:
        return err("Password must be at least 8 characters")

    hashed = bcrypt.hashpw(new_pw.encode(), bcrypt.gensalt()).decode()
    db.table("users").update({
        "password_hash":        hashed,
        "must_change_password": False,
    }).eq("id", session["user_id"]).execute()
    session["must_change_password"] = False

    return ok()


# ─────────────────────────────────────────────────────────────
# DASHBOARD
# ─────────────────────────────────────────────────────────────

@app.route("/api/dashboard/stats", methods=["GET"])
@_auth()
def dashboard_stats():
    cid  = session.get("clinic_id")
    role = session.get("role")

    # super_admin with no clinic assigned — return empty dashboard
    if not cid:
        chart = {}
        for i in range(7):
            d = (date.today() - timedelta(days=6-i)).isoformat()
            chart[d] = 0
        return ok({
            "today_patients":   0,
            "today_earnings":   0,
            "outstanding_debt": 0,
            "low_stock_count":  0,
            "monthly_revenue":  0,
            "chart_7days":      chart,
            "recent_visits":    [],
            "super_admin_note": "No clinic selected. Use the Super Admin panel to manage clinics.",
        })

    today = today_str()
    month_start = date.today().replace(day=1).isoformat()

    # Today's visits
    try:
        today_v = db.table("visits").select("amount_paid,remaining") \
            .eq("clinic_id", cid).eq("visit_date", today).execute()
        today_visits = today_v.data or []
    except Exception:
        today_visits = []
    today_patients = len(today_visits)
    today_earnings = sum(v.get("amount_paid", 0) or 0 for v in today_visits)

    # Total outstanding debt
    try:
        debt_r = db.table("visits").select("remaining").eq("clinic_id", cid).execute()
        outstanding = sum(v.get("remaining", 0) or 0 for v in (debt_r.data or []))
    except Exception:
        outstanding = 0

    # Monthly revenue
    try:
        month_v = db.table("visits").select("amount_paid") \
            .eq("clinic_id", cid).gte("visit_date", month_start).execute()
        monthly_revenue = sum(v.get("amount_paid", 0) or 0 for v in (month_v.data or []))
    except Exception:
        monthly_revenue = 0

    # Low stock count
    try:
        ll = db.table("lenses").select("quantity,min_stock").eq("clinic_id", cid).execute()
        lf = db.table("frames").select("quantity,min_stock").eq("clinic_id", cid).execute()
        low_count = (
            sum(1 for l in (ll.data or []) if (l.get("quantity") or 0) <= (l.get("min_stock") or 0)) +
            sum(1 for f in (lf.data or []) if (f.get("quantity") or 0) <= (f.get("min_stock") or 0))
        )
    except Exception:
        low_count = 0

    # Last 7 days revenue
    chart = {}
    for i in range(7):
        d = (date.today() - timedelta(days=6-i)).isoformat()
        chart[d] = 0
    try:
        seven_ago = (date.today() - timedelta(days=6)).isoformat()
        week_v = db.table("visits").select("visit_date,amount_paid") \
            .eq("clinic_id", cid).gte("visit_date", seven_ago).execute()
        for v in (week_v.data or []):
            d = v.get("visit_date")
            if d in chart:
                chart[d] += v.get("amount_paid", 0) or 0
    except Exception:
        pass

    # Recent 5 visits
    try:
        recent_v = db.table("visits").select(
            "id,visit_date,total_amount,amount_paid,remaining,patient_id,lens_type"
        ).eq("clinic_id", cid).order("visit_date", desc=True).limit(5).execute()
        recent_visits = recent_v.data or []
    except Exception:
        recent_visits = []

    return ok({
        "today_patients":   today_patients,
        "today_earnings":   today_earnings,
        "outstanding_debt": outstanding,
        "low_stock_count":  low_count,
        "monthly_revenue":  monthly_revenue,
        "chart_7days":      chart,
        "recent_visits":    recent_visits,
    })


# ─────────────────────────────────────────────────────────────
# PATIENTS
# ─────────────────────────────────────────────────────────────

@app.route("/api/patients", methods=["GET"])
@_auth(setting="recept_view_patients")
def list_patients():
    cid = session["clinic_id"]
    q   = request.args.get("q", "").strip()
    gender = request.args.get("gender", "")
    page   = max(1, int(request.args.get("page", 1)))
    limit  = min(500, int(request.args.get("limit", 50)))
    offset = (page - 1) * limit

    query = db.table("patients").select("*").eq("clinic_id", cid)

    if gender:
        query = query.eq("gender", gender)

    # Supabase doesn't support OR ilike natively in the Python client easily,
    # so we do a broad fetch and filter — fine for <10k patients per clinic
    res = query.order("created_at", desc=True).execute()
    rows = res.data or []

    if q:
        ql = q.lower()
        rows = [r for r in rows if ql in (r.get("full_name") or "").lower()
                or q in (r.get("phone") or "")]

    total = len(rows)
    rows  = rows[offset: offset + limit]

    patient_ids = [r["id"] for r in rows]
    if patient_ids:
        visits = db.table("visits").select("patient_id,remaining") \
            .eq("clinic_id", cid).in_("patient_id", patient_ids).execute()
        remaining_by_patient = {}
        for visit in (visits.data or []):
            pid = visit.get("patient_id")
            if pid in patient_ids:
                remaining_by_patient[pid] = remaining_by_patient.get(pid, 0) + float(visit.get("remaining") or 0)
        for row in rows:
            row["outstanding_remaining"] = remaining_by_patient.get(row["id"], 0)

    return ok(rows, total=total, page=page, limit=limit)


def _norm_phone(value):
    digits = "".join(ch for ch in str(value or "") if ch.isdigit())
    if digits.startswith("00964"):
        digits = digits[5:]
    elif digits.startswith("964"):
        digits = digits[3:]
    elif digits.startswith("0"):
        digits = digits[1:]
    return digits


def _patient_duplicate_matches(cid, full_name, phone, exclude_id=None):
    phone_key = _norm_phone(phone)
    matches = {}

    if (full_name or "").strip():
        name_res = db.table("patients").select("id,full_name,phone") \
            .eq("clinic_id", cid).ilike("full_name", full_name.strip()).limit(8).execute()
        for row in (name_res.data or []):
            if row.get("id") != exclude_id:
                matches[row["id"]] = row

    if phone_key:
        variants = list({
            phone or "",
            phone_key,
            "0" + phone_key,
            "964" + phone_key,
            "+964" + phone_key,
            "00964" + phone_key,
        })
        phone_res = db.table("patients").select("id,full_name,phone") \
            .eq("clinic_id", cid).in_("phone", variants).limit(12).execute()
        for row in (phone_res.data or []):
            if row.get("id") != exclude_id and _norm_phone(row.get("phone")) == phone_key:
                matches[row["id"]] = row
        if not matches:
            broad_phone_res = db.table("patients").select("id,full_name,phone") \
                .eq("clinic_id", cid).limit(1000).execute()
            for row in (broad_phone_res.data or []):
                if row.get("id") != exclude_id and _norm_phone(row.get("phone")) == phone_key:
                    matches[row["id"]] = row

    return list(matches.values())


@app.route("/api/patients", methods=["POST"])
@_auth(roles=["doctor", "super_admin", "receptionist"], setting="recept_edit_patients")
def create_patient():
    cid  = session.get("clinic_id")
    uid  = session.get("user_id")
    if not cid:
        return err("No clinic assigned to this account. Please contact the administrator.", 400)
    body = request.get_json() or {}

    full_name = (body.get("full_name") or "").strip()
    phone = (body.get("phone") or "").strip()
    if not full_name:
        return err("full_name is required")

    # Check for duplicates using targeted server-side queries — avoids a
    # full-table scan that would break on large clinics or exceed Supabase's
    # default 1 000-row response limit.
    duplicates = _patient_duplicate_matches(cid, full_name, phone)
    if duplicates and not bool(body.get("allow_duplicate")):
        return err(
            "A patient with the same name or phone already exists",
            409,
            duplicates=duplicates,
            code="duplicate_patient",
        )

    row = {
        "clinic_id":  cid,
        "full_name":  full_name,
        "phone":      phone,
        "age":        body.get("age"),
        "gender":     body.get("gender"),
        "address":    body.get("address"),
        "notes":      body.get("notes"),
        "created_at": now_iso(),
        "updated_at": now_iso(),
    }

    res = db.table("patients").insert(row).execute()
    patient = res.data[0]

    _write_audit(cid, uid, "create", "patient", patient["id"], new_value=patient)
    return ok(patient), 201


@app.route("/api/patients/<pid>", methods=["GET"])
@_auth(setting="recept_view_patients")
def get_patient(pid):
    cid = session["clinic_id"]
    res = db.table("patients").select("*").eq("clinic_id", cid).eq("id", pid).limit(1).execute()
    if not res.data:
        return err("Patient not found", 404)
    patient_row = res.data[0]

    visits = db.table("visits").select("*").eq("clinic_id", cid) \
        .eq("patient_id", pid).order("visit_date", desc=True).execute()

    return ok({**patient_row, "visits": visits.data or []})


@app.route("/api/patients/<pid>", methods=["PUT"])
@_auth(setting="recept_edit_patients")
def update_patient(pid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("patients").select("*").eq("clinic_id", cid).eq("id", pid).limit(1).execute()
    if not old.data:
        return err("Patient not found", 404)
    old_row = old.data[0]

    allowed = ["full_name","phone","age","gender","address","notes"]
    updates = {k: v for k, v in body.items() if k in allowed}
    if "full_name" in updates or "phone" in updates:
        new_name = updates.get("full_name", old_row.get("full_name"))
        new_phone = updates.get("phone", old_row.get("phone"))
        duplicates = _patient_duplicate_matches(cid, new_name, new_phone, exclude_id=pid)
        if duplicates and not bool(body.get("allow_duplicate")):
            return err(
                "A patient with the same name or phone already exists",
                409,
                duplicates=duplicates,
                code="duplicate_patient",
            )
    updates["updated_at"] = now_iso()

    res = db.table("patients").update(updates).eq("clinic_id", cid).eq("id", pid).execute()
    _write_audit(cid, uid, "update", "patient", pid, old_value=old_row, new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/visits/<vid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_visit(vid):
    cid = session["clinic_id"]
    uid = session["user_id"]

    old = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).limit(1).execute()
    if not old.data:
        return err("Visit not found", 404)
    old_row = old.data[0]

    patient_id = old_row.get("patient_id")
    db.table("visits").delete().eq("clinic_id", cid).eq("id", vid).execute()
    if patient_id:
        db.table("patients").update({"updated_at": now_iso()}).eq("clinic_id", cid).eq("id", patient_id).execute()

    _write_audit(cid, uid, "delete", "visit", vid, old_value=old_row)
    return ok()


@app.route("/api/patients/<pid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_patient(pid):
    cid = session["clinic_id"]
    uid = session["user_id"]

    old = db.table("patients").select("id,full_name").eq("clinic_id", cid).eq("id", pid).limit(1).execute()
    if not old.data:
        return err("Patient not found", 404)
    old_row = old.data[0]

    # Cascade delete visits
    db.table("visits").delete().eq("clinic_id", cid).eq("patient_id", pid).execute()
    db.table("patients").delete().eq("clinic_id", cid).eq("id", pid).execute()

    _write_audit(cid, uid, "delete", "patient", pid, old_value=old_row)
    return ok()


# ─────────────────────────────────────────────────────────────
# VISITS
# ─────────────────────────────────────────────────────────────

@app.route("/api/visits", methods=["POST"])
@_auth(setting="recept_edit_patients")
def create_visit():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    patient_id = body.get("patient_id")
    if not patient_id:
        return err("patient_id is required")

    # Verify patient belongs to this clinic
    p = db.table("patients").select("id").eq("clinic_id", cid).eq("id", patient_id).limit(1).execute()
    if not p.data:
        return err("Patient not found", 404)

    # ── Enum-safe helpers ──────────────────────────────────────
    VALID_FRAME_TYPES    = {"full_rim","half_rim","rimless"}

    def _enum_or_none(val, valid_set):
        """Return val if it's a non-empty member of valid_set, else None."""
        return val if (val and str(val).strip() in valid_set) else None

    def _float_or_none(val):
        try:    return float(val) if val not in (None, "", "null") else None
        except: return None

    def _int_or_none(val):
        try:    return int(val) if val not in (None, "", "null") else None
        except: return None

    # ── Plano guard — force zero power if lens_type == plano ──
    raw_lens_type = body.get("lens_type") or ""
    lens_type = raw_lens_type.strip() or None
    if lens_type == "plano":
        for fld in ["od_sphere","od_cylinder","os_sphere","os_cylinder"]:
            body[fld] = 0

    # ── Lens coating: strip empty / invalid values ─────────────
    raw_coating = body.get("lens_coating") or ""
    # visits.lens_coating is TEXT (not enum), safe to store comma-separated values
    lens_coating = raw_coating.strip() if raw_coating.strip() else "clear"

    # ── Frame type: must be valid enum or None ──────────────────
    frame_type = _enum_or_none((body.get("frame_type") or "").strip(), VALID_FRAME_TYPES)

    # ── Lens material: must be valid enum or None ───────────────
    lens_material = (body.get("lens_material") or "").strip() or None

    frame_price   = float(body.get("frame_price", 0) or 0)
    lens_price    = float(body.get("lens_price", 0) or 0)
    checkup_fee   = float(body.get("checkup_fee", 0) or 0)
    total_amount  = frame_price + lens_price + checkup_fee
    amount_paid   = float(body.get("amount_paid", 0) or 0)
    remaining     = max(0, total_amount - amount_paid)

    # VA / BCVA: store as-is (text), but strip whitespace
    def _va_clean(val):
        return (val or "").strip() or None

    row = {
        "clinic_id":     cid,
        "patient_id":    patient_id,
        "visit_date":    body.get("visit_date") or today_str(),
        # Rx OD
        "od_sphere":     _float_or_none(body.get("od_sphere")),
        "od_cylinder":   _float_or_none(body.get("od_cylinder")),
        "od_axis":       _int_or_none(body.get("od_axis")),
        "od_addition":   _float_or_none(body.get("od_addition")),
        "od_va":         _va_clean(body.get("od_va")),
        "od_bcva":       _va_clean(body.get("od_bcva")),
        # Rx OS
        "os_sphere":     _float_or_none(body.get("os_sphere")),
        "os_cylinder":   _float_or_none(body.get("os_cylinder")),
        "os_axis":       _int_or_none(body.get("os_axis")),
        "os_addition":   _float_or_none(body.get("os_addition")),
        "os_va":         _va_clean(body.get("os_va")),
        "os_bcva":       _va_clean(body.get("os_bcva")),
        # Shared
        "ipd":           _float_or_none(body.get("ipd")),
        # Lens config
        "lens_type":     lens_type,
        "lens_material": lens_material,
        "lens_coating":  lens_coating,
        "lens_count":    _int_or_none(body.get("lens_count")) or 2,
        # Frame
        "frame_id":      body.get("frame_id") or None,
        "frame_brand":   (body.get("frame_brand") or "").strip() or None,
        "frame_type":    frame_type,
        "frame_material":(body.get("frame_material") or "").strip() or None,
        # Checkup
        "did_checkup":       bool(body.get("did_checkup", False)),
        "next_visit_date":   body.get("next_visit_date") or None,
        "followup_months":   _int_or_none(body.get("followup_months")) or 3,
        # Financials
        "frame_cost":    _float_or_none(body.get("frame_cost")) or 0,
        "frame_price":   frame_price,
        "lens_cost":     _float_or_none(body.get("lens_cost")) or 0,
        "lens_price":    lens_price,
        "checkup_fee":   checkup_fee,
        "total_amount":  total_amount,
        "amount_paid":   amount_paid,
        "remaining":     remaining,
        "notes":         (body.get("notes") or "").strip() or None,
        "created_by":    uid,
        # Inventory reference
        "lens_id":       body.get("lens_id") or None,
    }

    # ── Inventory deduction (optimistic-lock guard) ──────────────────────────
    # Each UPDATE conditions on the quantity we just read.  If a concurrent
    # request already decremented it, the WHERE clause won't match and .data
    # will be empty — we treat that as a stock conflict and abort.
    lens_id  = body.get("lens_id")
    frame_id = body.get("frame_id")
    lens_count = int(body.get("lens_count", 2))

    if lens_id:
        l = db.table("lenses").select("quantity,min_stock").eq("clinic_id", cid).eq("id", lens_id).limit(1).execute()
        if l.data:
            current_qty = l.data[0]["quantity"]
            if current_qty < lens_count:
                return err(f"Insufficient lens stock (have {current_qty}, need {lens_count})", 409)
            new_qty = current_qty - lens_count
            updated = db.table("lenses").update({"quantity": new_qty}) \
                .eq("clinic_id", cid).eq("id", lens_id) \
                .eq("quantity", current_qty).execute()   # optimistic lock
            if not updated.data:
                return err("Lens stock changed while saving. Please try again.", 409)

    if frame_id:
        f = db.table("frames").select("quantity").eq("clinic_id", cid).eq("id", frame_id).limit(1).execute()
        if f.data:
            current_qty = f.data[0]["quantity"]
            if current_qty < 1:
                return err("Frame out of stock", 409)
            updated = db.table("frames").update({"quantity": current_qty - 1}) \
                .eq("clinic_id", cid).eq("id", frame_id) \
                .eq("quantity", current_qty).execute()   # optimistic lock
            if not updated.data:
                return err("Frame stock changed while saving. Please try again.", 409)

    res = db.table("visits").insert(row).execute()
    visit = res.data[0]

    # Update patient updated_at
    db.table("patients").update({"updated_at": now_iso()}).eq("clinic_id", cid).eq("id", patient_id).execute()

    _write_audit(cid, uid, "create", "visit", visit["id"], new_value=visit)
    return ok(visit), 201


@app.route("/api/visits/<vid>", methods=["GET"])
@_auth(setting="recept_view_patients")
def get_visit(vid):
    cid = session["clinic_id"]
    res = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).limit(1).execute()
    if not res.data:
        return err("Visit not found", 404)
    return ok(res.data[0])


@app.route("/api/visits/<vid>/print", methods=["GET"])
@_auth(setting="recept_view_patients")
def get_visit_print_payload(vid):
    cid = session["clinic_id"]
    visit = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).limit(1).execute()
    if not visit.data:
        return err("Visit not found", 404)
    visit_row = visit.data[0]

    patient = db.table("patients").select("*").eq("clinic_id", cid) \
        .eq("id", visit_row["patient_id"]).limit(1).execute()
    clinic = db.table("clinics").select("id,name,logo_url,phone,address").eq("id", cid).limit(1).execute()
    settings = db.table("clinic_settings").select("*").eq("clinic_id", cid).limit(1).execute()

    return ok({
        "visit":    visit_row,
        "patient":  patient.data[0] if patient.data else {},
        "clinic":   clinic.data[0] if clinic.data else {},
        "settings": settings.data[0] if settings.data else {},
    })


@app.route("/api/visits/<vid>", methods=["PUT"])
@_auth(setting="recept_edit_patients")
def update_visit(vid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).limit(1).execute()
    if not old.data:
        return err("Visit not found", 404)
    old_row = old.data[0]

    allowed = [
        "od_sphere","od_cylinder","od_axis","od_addition","od_va","od_bcva",
        "os_sphere","os_cylinder","os_axis","os_addition","os_va","os_bcva",
        "ipd","lens_type","lens_material","lens_coating","lens_count",
        "frame_brand","frame_type","frame_material",
        "did_checkup","next_visit_date","followup_months",
        "frame_cost","frame_price","lens_cost","lens_price","checkup_fee",
        "amount_paid","notes",
    ]
    updates = {k: v for k, v in body.items() if k in allowed}

    # Recalculate totals if any price changed
    price_fields = {"frame_price","lens_price","checkup_fee","amount_paid"}
    if price_fields & set(updates.keys()):
        fp   = float(updates.get("frame_price",  old_row.get("frame_price",  0)) or 0)
        lp   = float(updates.get("lens_price",   old_row.get("lens_price",   0)) or 0)
        cf   = float(updates.get("checkup_fee",  old_row.get("checkup_fee",  0)) or 0)
        paid = float(updates.get("amount_paid",  old_row.get("amount_paid",  0)) or 0)
        updates["total_amount"] = fp + lp + cf
        updates["remaining"]    = max(0, updates["total_amount"] - paid)

    # ── Enum-safe sanitisation ──────────────────────────────────
    VALID_FRAME_TYPES    = {"full_rim","half_rim","rimless"}

    if "lens_type" in updates:
        v = (updates["lens_type"] or "").strip()
        updates["lens_type"] = v or None
    if "lens_material" in updates:
        v = (updates["lens_material"] or "").strip()
        updates["lens_material"] = v or None
    if "frame_type" in updates:
        v = (updates["frame_type"] or "").strip()
        updates["frame_type"] = v if v in VALID_FRAME_TYPES else None
    if "lens_coating" in updates:
        v = (updates["lens_coating"] or "").strip()
        updates["lens_coating"] = v or None

    # Plano guard
    if updates.get("lens_type") == "plano":
        for fld in ["od_sphere","od_cylinder","os_sphere","os_cylinder"]:
            updates[fld] = 0

    res = db.table("visits").update(updates).eq("clinic_id", cid).eq("id", vid).execute()
    _write_audit(cid, uid, "update", "visit", vid, old_value=old_row, new_value=res.data[0])
    return ok(res.data[0])


# ─────────────────────────────────────────────────────────────
# FOLLOW-UPS
# ─────────────────────────────────────────────────────────────

@app.route("/api/followups", methods=["GET"])
@_auth(setting="recept_view_patients")
def list_followups():
    cid = session["clinic_id"]
    days_ahead = int(request.args.get("days", 14))
    cutoff = (date.today() + timedelta(days=days_ahead)).isoformat()

    res = db.table("visits").select(
        "id,patient_id,visit_date,next_visit_date,lens_type,lens_material,lens_coating,frame_brand,frame_type,total_amount,amount_paid,remaining,od_sphere,od_cylinder,od_axis,os_sphere,os_cylinder,os_axis"
    ).eq("clinic_id", cid).eq("did_checkup", True) \
     .not_.is_("next_visit_date", "null") \
     .lte("next_visit_date", cutoff) \
     .order("next_visit_date").execute()

    rows = res.data or []

    # Attach patient names / phones
    patient_ids = list({r["patient_id"] for r in rows})
    patients_map = {}
    if patient_ids:
        pres = db.table("patients").select("id,full_name,phone") \
            .eq("clinic_id", cid).in_("id", patient_ids).execute()
        patients_map = {p["id"]: p for p in (pres.data or [])}

    for r in rows:
        p = patients_map.get(r["patient_id"], {})
        r["patient_name"] = p.get("full_name")
        r["patient_phone"] = p.get("phone")
        if r["next_visit_date"]:
            delta = (date.fromisoformat(r["next_visit_date"]) - date.today()).days
            r["days_until"] = delta

    return ok(rows)


# ─────────────────────────────────────────────────────────────
# LENS INVENTORY
# ─────────────────────────────────────────────────────────────

def _seed_lens_catalog(cid):
    rows = []
    for category, items in DEFAULT_LENS_CATALOG.items():
        for idx, (value, label) in enumerate(items):
            rows.append({
                "clinic_id": cid,
                "category": category,
                "value": value,
                "label": label,
                "is_active": True,
                "sort_order": idx,
            })
    if rows:
        db.table("clinic_lens_catalog").insert(rows).execute()


def _get_lens_catalog_rows(cid):
    res = db.table("clinic_lens_catalog").select("*").eq("clinic_id", cid) \
        .order("category").order("sort_order").execute()
    rows = res.data or []
    if not rows:
        _seed_lens_catalog(cid)
        res = db.table("clinic_lens_catalog").select("*").eq("clinic_id", cid) \
            .order("category").order("sort_order").execute()
        rows = res.data or []
    return rows


def _catalog_response(rows):
    catalog = {"type": [], "material": [], "coating": []}
    for row in rows:
        category = row.get("category")
        if category in catalog:
            catalog[category].append({
                "value": row.get("value"),
                "label": row.get("label") or row.get("value"),
                "is_active": row.get("is_active") is not False,
                "sort_order": row.get("sort_order") or 0,
            })
    return catalog


@app.route("/api/lens-catalog", methods=["GET"])
@_auth()
def get_lens_catalog():
    cid = session["clinic_id"]
    return ok(_catalog_response(_get_lens_catalog_rows(cid)))


@app.route("/api/lens-catalog", methods=["PUT"])
@_auth(roles=["doctor", "super_admin"])
def update_lens_catalog():
    cid = session["clinic_id"]
    uid = session["user_id"]
    body = request.get_json() or {}
    rows = []
    for category in ["type", "material", "coating"]:
        for idx, item in enumerate(body.get(category) or []):
            label = (item.get("label") or item.get("value") or "").strip()
            value = _slugify_lens_value(item.get("value") or label)
            if not label or not value:
                continue
            rows.append({
                "clinic_id": cid,
                "category": category,
                "value": value,
                "label": label,
                "is_active": item.get("is_active", True) is not False,
                "sort_order": int(item.get("sort_order", idx) or idx),
            })

    db.table("clinic_lens_catalog").delete().eq("clinic_id", cid).execute()
    if rows:
        db.table("clinic_lens_catalog").insert(rows).execute()
    _write_audit(cid, uid, "update", "lens_catalog", cid, new_value={"items": len(rows)})
    return ok(_catalog_response(rows))


def _lens_inventory_key(row):
    return (
        str(row.get("lens_type") or ""),
        str(row.get("material") or ""),
        str(row.get("coating") or "clear"),
        round(_num_or_zero(row.get("sphere")), 2),
        round(_num_or_zero(row.get("cylinder")), 2),
    )


def _power_range(start, end, step):
    start = float(start)
    end = float(end)
    step = abs(float(step or 0.25))
    if step <= 0:
        step = 0.25
    direction = 1 if end >= start else -1
    values = []
    cur = start
    guard = 0
    while (cur <= end + 1e-9 if direction > 0 else cur >= end - 1e-9):
        values.append(round(cur, 2))
        cur += direction * step
        guard += 1
        if guard > 1000:
            break
    return values


@app.route("/api/lenses/bulk-generate", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def bulk_generate_lenses():
    cid = session["clinic_id"]
    uid = session["user_id"]
    body = request.get_json() or {}
    existing_mode = body.get("existing_mode") if body.get("existing_mode") in {"update", "skip"} else "skip"
    lens_types = body.get("lens_types") or []
    materials = body.get("materials") or []
    coatings = body.get("coatings") or ["clear"]
    ranges = body.get("ranges") or {}
    defaults = body.get("defaults") or {}

    if not lens_types or not materials or not coatings:
        return err("Choose at least one type, material, and coating")

    spheres = _power_range(ranges.get("sphere_start", 0), ranges.get("sphere_end", 0), ranges.get("sphere_step", 0.25))
    cylinders = _power_range(ranges.get("cylinder_start", 0), ranges.get("cylinder_end", 0), ranges.get("cylinder_step", 0.25))
    generated_count = len(lens_types) * len(materials) * len(coatings) * len(spheres) * len(cylinders)
    if generated_count > 500 and not bool(body.get("confirm_large")):
        return err("Large generation requires confirmation", 409, code="large_lens_generation", count=generated_count)
    if generated_count > 10000:
        return err("Please narrow the ranges. Maximum is 10000 generated rows.", 400)

    existing_rows = db.table("lenses").select("*").eq("clinic_id", cid).execute()
    existing = {_lens_inventory_key(row): row for row in (existing_rows.data or [])}
    to_insert = []
    updated = 0
    skipped = 0
    quantity = int(defaults.get("quantity") or 0)
    min_stock = int(defaults.get("min_stock") or 2)
    cost_price = defaults.get("cost_price") or 0
    sell_price = defaults.get("sell_price") or 0

    for lens_type in lens_types:
        for material in materials:
            for coating in coatings:
                for sphere in spheres:
                    for cylinder in cylinders:
                        row = {
                            "clinic_id": cid,
                            "lens_type": lens_type,
                            "material": material,
                            "coating": coating or "clear",
                            "sphere": sphere,
                            "cylinder": cylinder,
                            "quantity": quantity,
                            "min_stock": min_stock,
                            "cost_price": cost_price,
                            "sell_price": sell_price,
                            "updated_at": now_iso(),
                        }
                        key = _lens_inventory_key(row)
                        if key in existing:
                            if existing_mode == "update":
                                db.table("lenses").update({
                                    "quantity": quantity,
                                    "min_stock": min_stock,
                                    "cost_price": cost_price,
                                    "sell_price": sell_price,
                                    "updated_at": now_iso(),
                                }).eq("clinic_id", cid).eq("id", existing[key]["id"]).execute()
                                updated += 1
                            else:
                                skipped += 1
                        else:
                            to_insert.append(row)

    inserted = 0
    for i in range(0, len(to_insert), 500):
        chunk = to_insert[i:i + 500]
        if chunk:
            db.table("lenses").insert(chunk).execute()
            inserted += len(chunk)

    _write_audit(cid, uid, "create", "lens", new_value={
        "bulk_generated": generated_count,
        "inserted": inserted,
        "updated": updated,
        "skipped": skipped,
    })
    return ok({"generated": generated_count, "inserted": inserted, "updated": updated, "skipped": skipped})


@app.route("/api/lenses", methods=["GET"])
@_auth(setting="recept_access_inventory")
def list_lenses():
    cid = session["clinic_id"]
    args = request.args

    query = db.table("lenses").select("*").eq("clinic_id", cid)

    if args.get("lens_type"):
        query = query.eq("lens_type", args["lens_type"])
    if args.get("material"):
        query = query.eq("material", args["material"])
    if args.get("coating"):
        query = query.eq("coating", args["coating"])

    res = query.order("lens_type").order("sphere").execute()
    rows = res.data or []

    # Optional power filter (±0.25)
    for eye in ["od","os"]:
        sph_key = f"{eye}_sph"
        cyl_key = f"{eye}_cyl"
        if args.get(sph_key):
            sph = float(args[sph_key])
            rows = [r for r in rows if abs((r.get("sphere") or 0) - sph) <= 0.25]
        if args.get(cyl_key):
            cyl = float(args[cyl_key])
            rows = [r for r in rows if abs((r.get("cylinder") or 0) - cyl) <= 0.25]

    return ok(rows)


@app.route("/api/lenses", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def create_lens():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    # Bulk create support (from wizard)
    if isinstance(body, list):
        rows = [{**b, "clinic_id": cid} for b in body]
        res = db.table("lenses").insert(rows).execute()
        _write_audit(cid, uid, "create", "lens", new_value={"bulk": len(rows)})
        return ok(res.data), 201

    # Accept both 'material' and 'lens_material' key names from frontend
    material = body.get("material") or body.get("lens_material")
    row = {
        "clinic_id":  cid,
        "lens_type":  body.get("lens_type"),
        "material":   material,
        "coating":    body.get("coating", "clear"),
        "sphere":     body.get("sphere"),
        "cylinder":   body.get("cylinder", 0),
        "quantity":   int(body.get("quantity", 0)),
        "min_stock":  int(body.get("min_stock", 2)),
        "cost_price": body.get("cost_price"),
        "sell_price": body.get("sell_price"),
        "updated_at": now_iso(),
    }
    res = db.table("lenses").insert(row).execute()
    _write_audit(cid, uid, "create", "lens", res.data[0]["id"], new_value=res.data[0])
    return ok(res.data[0]), 201


@app.route("/api/lenses/<lid>", methods=["PUT"])
@_auth(roles=["doctor", "super_admin"])
def update_lens(lid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("lenses").select("*").eq("clinic_id", cid).eq("id", lid).limit(1).execute()
    if not old.data:
        return err("Lens not found", 404)

    allowed = ["lens_type","material","coating","sphere","cylinder","quantity","min_stock","cost_price","sell_price"]
    updates = {k: v for k, v in body.items() if k in allowed}
    # Accept 'lens_material' as an alias for 'material' (frontend naming inconsistency)
    if "lens_material" in body and "material" not in updates:
        updates["material"] = body["lens_material"]
    updates["updated_at"] = now_iso()

    res = db.table("lenses").update(updates).eq("clinic_id", cid).eq("id", lid).execute()
    _write_audit(cid, uid, "update", "lens", lid, old_value=old.data[0], new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/lenses/<lid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_lens(lid):
    cid = session["clinic_id"]
    uid = session["user_id"]
    old = db.table("lenses").select("*").eq("clinic_id", cid).eq("id", lid).limit(1).execute()
    if not old.data:
        return err("Lens not found", 404)
    db.table("lenses").delete().eq("clinic_id", cid).eq("id", lid).execute()
    _write_audit(cid, uid, "delete", "lens", lid, old_value=old.data[0])
    return ok()


@app.route("/api/lenses/<lid>/restock", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def restock_lens(lid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}
    qty  = int(body.get("quantity", 0))
    if qty <= 0:
        return err("quantity must be positive")

    l = db.table("lenses").select("quantity").eq("clinic_id", cid).eq("id", lid).limit(1).execute()
    if not l.data:
        return err("Lens not found", 404)

    new_qty = l.data[0]["quantity"] + qty
    res = db.table("lenses").update({"quantity": new_qty, "updated_at": now_iso()}) \
        .eq("clinic_id", cid).eq("id", lid).execute()

    _write_audit(cid, uid, "update", "lens", lid, new_value={"restocked": qty, "new_qty": new_qty})
    return ok(res.data[0])


@app.route("/api/lenses/match", methods=["GET"])
@_auth()
def match_lenses():
    """Return inventory lenses within ±0.25 of OD and OS powers."""
    cid = session["clinic_id"]
    args = request.args

    res = db.table("lenses").select("*").eq("clinic_id", cid).gt("quantity", 0).execute()
    rows = res.data or []

    results = []
    for r in rows:
        match = False
        for eye in ["od", "os"]:
            sph = args.get(f"{eye}_sph")
            cyl = args.get(f"{eye}_cyl")
            if sph is not None:
                if abs((r.get("sphere") or 0) - float(sph)) <= 0.25:
                    cyl_ok = True
                    if cyl is not None:
                        cyl_ok = abs((r.get("cylinder") or 0) - float(cyl)) <= 0.25
                    if cyl_ok:
                        match = True
        if match:
            results.append(r)

    return ok(results)


# ─────────────────────────────────────────────────────────────
# FRAMES INVENTORY
# ─────────────────────────────────────────────────────────────

@app.route("/api/frames", methods=["GET"])
@_auth(setting="recept_access_inventory")
def list_frames():
    cid = session["clinic_id"]
    res = db.table("frames").select("*").eq("clinic_id", cid) \
        .order("brand").execute()
    return ok(res.data or [])


@app.route("/api/frames", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def create_frame():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    row = {
        "clinic_id":      cid,
        "brand":          body.get("brand"),
        "frame_type":     body.get("frame_type"),
        "frame_material": body.get("frame_material"),
        "color":          body.get("color"),
        "quantity":       int(body.get("quantity", 0)),
        "min_stock":      int(body.get("min_stock", 2)),
        "cost_price":     body.get("cost_price"),
        "sell_price":     body.get("sell_price"),
        "updated_at":     now_iso(),
    }
    res = db.table("frames").insert(row).execute()
    _write_audit(cid, uid, "create", "frame", res.data[0]["id"], new_value=res.data[0])
    return ok(res.data[0]), 201


@app.route("/api/frames/<fid>", methods=["PUT"])
@_auth(roles=["doctor", "super_admin"])
def update_frame(fid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("frames").select("*").eq("clinic_id", cid).eq("id", fid).limit(1).execute()
    if not old.data:
        return err("Frame not found", 404)

    allowed = ["brand","frame_type","frame_material","color","quantity","min_stock","cost_price","sell_price"]
    updates = {k: v for k, v in body.items() if k in allowed}
    updates["updated_at"] = now_iso()

    res = db.table("frames").update(updates).eq("clinic_id", cid).eq("id", fid).execute()
    _write_audit(cid, uid, "update", "frame", fid, old_value=old.data[0], new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/frames/<fid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_frame(fid):
    cid = session["clinic_id"]
    uid = session["user_id"]
    old = db.table("frames").select("*").eq("clinic_id", cid).eq("id", fid).limit(1).execute()
    if not old.data:
        return err("Frame not found", 404)
    db.table("frames").delete().eq("clinic_id", cid).eq("id", fid).execute()
    _write_audit(cid, uid, "delete", "frame", fid, old_value=old.data[0])
    return ok()


@app.route("/api/frames/<fid>/restock", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def restock_frame(fid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}
    qty  = int(body.get("quantity", 0))
    if qty <= 0:
        return err("quantity must be positive")

    f = db.table("frames").select("quantity").eq("clinic_id", cid).eq("id", fid).limit(1).execute()
    if not f.data:
        return err("Frame not found", 404)

    new_qty = f.data[0]["quantity"] + qty
    res = db.table("frames").update({"quantity": new_qty, "updated_at": now_iso()}) \
        .eq("clinic_id", cid).eq("id", fid).execute()

    _write_audit(cid, uid, "update", "frame", fid, new_value={"restocked": qty, "new_qty": new_qty})
    return ok(res.data[0])


# ─────────────────────────────────────────────────────────────
# REPORTS
# ─────────────────────────────────────────────────────────────

def _float_val(value):
    try:
        return float(value or 0)
    except (TypeError, ValueError):
        return 0.0


def _months_between(start, end):
    count = 0
    cursor = date(start.year, start.month, 1)
    limit = date(end.year, end.month, 1)
    while cursor <= limit:
        count += 1
        if cursor.month == 12:
            cursor = date(cursor.year + 1, 1, 1)
        else:
            cursor = date(cursor.year, cursor.month + 1, 1)
    return count


def _expense_occurrences(expense, start, end):
    starts_on = date.fromisoformat(expense.get("starts_on") or start.isoformat())
    if starts_on > end:
        return 0
    effective_start = max(start, starts_on)
    frequency = (expense.get("frequency") or "monthly").lower()
    if frequency in ("one_time", "once"):
        return 1 if start <= starts_on <= end else 0
    if frequency == "daily":
        return (end - effective_start).days + 1
    if frequency == "weekly":
        return ((end - effective_start).days // 7) + 1
    if frequency == "yearly":
        return max(1, end.year - effective_start.year + 1)
    # Default monthly.
    return _months_between(effective_start, end)


def _add_chart_item(items, key, label, kind, amount=0, cost=0, count=0):
    if key not in items:
        items[key] = {"key": key, "label": label, "kind": kind, "amount": 0, "cost": 0, "count": 0}
    items[key]["amount"] += _float_val(amount)
    items[key]["cost"] += _float_val(cost)
    items[key]["count"] += int(count or 0)


@app.route("/api/reports/summary", methods=["GET"])
@limiter.limit("60 per hour")
@_auth(setting="recept_view_financials")
def reports_summary():
    cid       = session["clinic_id"]
    date_from = request.args.get("from", date.today().replace(day=1).isoformat())
    date_to   = request.args.get("to",   today_str())
    start_date = date.fromisoformat(date_from)
    end_date = date.fromisoformat(date_to)

    visits = db.table("visits").select(
        "id,patient_id,visit_date,total_amount,amount_paid,remaining,lens_type,lens_price,lens_cost,frame_brand,frame_type,frame_price,frame_cost,checkup_fee,created_at"
    ).eq("clinic_id", cid).gte("visit_date", date_from).lte("visit_date", date_to) \
     .order("visit_date", desc=True).execute()

    rows = visits.data or []
    chart_items = {}

    revenue     = sum(r.get("amount_paid",  0) or 0 for r in rows)
    outstanding = sum(r.get("remaining",    0) or 0 for r in rows)
    visit_cost  = sum(_float_val(r.get("lens_cost")) + _float_val(r.get("frame_cost")) for r in rows)
    patient_ids = list({r["patient_id"] for r in rows})
    patients_map = {}
    if patient_ids:
        try:
            pres = db.table("patients").select("id,full_name,phone") \
                .eq("clinic_id", cid).in_("id", patient_ids).execute()
            patients_map = {p["id"]: p for p in (pres.data or [])}
        except Exception:
            patients_map = {}

    for r in rows:
        p = patients_map.get(r.get("patient_id"), {})
        r["patient_name"] = p.get("full_name")
        r["patient_phone"] = p.get("phone")

    for r in rows:
        lens_amount = _float_val(r.get("lens_price"))
        if lens_amount:
            label = f"Lens: {(r.get('lens_type') or 'Unknown').replace('_', ' ')}"
            _add_chart_item(chart_items, f"lens:{r.get('lens_type') or 'unknown'}", label, "lens",
                            amount=lens_amount, cost=r.get("lens_cost"), count=1)
        frame_amount = _float_val(r.get("frame_price"))
        if frame_amount:
            frame_label = r.get("frame_brand") or r.get("frame_type") or "Unknown"
            _add_chart_item(chart_items, f"frame:{frame_label}", f"Frame: {frame_label}", "frame",
                            amount=frame_amount, cost=r.get("frame_cost"), count=1)
        checkup_amount = _float_val(r.get("checkup_fee"))
        if checkup_amount:
            _add_chart_item(chart_items, "service:checkup", "Checkup fees", "service",
                            amount=checkup_amount, cost=0, count=1)

    try:
        retail_res = db.table("retail_sales").select("*").eq("clinic_id", cid) \
            .gte("sale_date", date_from).lte("sale_date", date_to) \
            .order("sale_date", desc=True).execute()
        retail_sales = retail_res.data or []
    except Exception:
        retail_sales = []

    retail_revenue = 0
    retail_cost = 0
    for sale in retail_sales:
        qty = int(sale.get("quantity") or 1)
        amount = _float_val(sale.get("selling_price")) * qty
        cost = _float_val(sale.get("cost_price")) * qty
        retail_revenue += amount
        retail_cost += cost
        label = f"{sale.get('item_name') or sale.get('item_type') or 'Retail item'}"
        _add_chart_item(chart_items, f"retail:{label}", label, "retail", amount=amount, cost=cost, count=qty)

    try:
        expense_res = db.table("operating_expenses").select("*").eq("clinic_id", cid) \
            .eq("is_active", True).lte("starts_on", date_to).order("starts_on", desc=True).execute()
        expenses = expense_res.data or []
    except Exception:
        expenses = []

    operating_costs = 0
    expense_rows = []
    for expense in expenses:
        occurrences = _expense_occurrences(expense, start_date, end_date)
        effective_amount = _float_val(expense.get("amount")) * occurrences
        if effective_amount <= 0:
            continue
        row = {**expense, "effective_amount": effective_amount, "occurrences": occurrences}
        expense_rows.append(row)
        operating_costs += effective_amount
        label = expense.get("name") or expense.get("expense_type") or "Expense"
        _add_chart_item(chart_items, f"expense:{label}", label, "expense", amount=effective_amount, cost=effective_amount, count=occurrences)

    # New patients in range
    new_ps = db.table("patients").select("id").eq("clinic_id", cid) \
        .gte("created_at", date_from + "T00:00:00") \
        .lte("created_at", date_to   + "T23:59:59").execute()

    return ok({
        "total_revenue":     revenue + retail_revenue,
        "total_outstanding": outstanding,
        "retail_revenue":    retail_revenue,
        "retail_cost":       retail_cost,
        "visit_cost":        visit_cost,
        "operating_costs":   operating_costs,
        "gross_profit":      revenue + retail_revenue - visit_cost - retail_cost - operating_costs,
        "patients_seen":     len(rows),
        "unique_patients":   len(patient_ids),
        "new_patients":      len(new_ps.data or []),
        "visits":            rows,
        "retail_sales":      retail_sales,
        "expenses":          expense_rows,
        "chart_items":       list(chart_items.values()),
    })


@app.route("/api/retail-sales", methods=["GET"])
@_auth(setting="recept_view_financials")
def list_retail_sales():
    cid = session["clinic_id"]
    date_from = request.args.get("from", date.today().replace(day=1).isoformat())
    date_to = request.args.get("to", today_str())
    res = db.table("retail_sales").select("*").eq("clinic_id", cid) \
        .gte("sale_date", date_from).lte("sale_date", date_to) \
        .order("sale_date", desc=True).execute()
    return ok(res.data or [])


@app.route("/api/retail-sales", methods=["POST"])
@_auth(setting="recept_edit_financials")
def create_retail_sale():
    cid = session["clinic_id"]
    uid = session["user_id"]
    body = request.get_json() or {}
    item_name = (body.get("item_name") or "").strip()
    if not item_name:
        return err("item_name is required")
    row = {
        "clinic_id": cid,
        "item_name": item_name,
        "item_type": body.get("item_type") or "misc",
        "quantity": int(body.get("quantity") or 1),
        "cost_price": _float_val(body.get("cost_price")),
        "selling_price": _float_val(body.get("selling_price")),
        "sale_date": body.get("sale_date") or today_str(),
        "notes": body.get("notes"),
        "created_by": uid,
    }
    res = db.table("retail_sales").insert(row).execute()
    _write_audit(cid, uid, "create", "retail_sale", res.data[0]["id"], new_value=res.data[0])
    return ok(res.data[0]), 201


@app.route("/api/operating-expenses", methods=["GET"])
@_auth(setting="recept_view_financials")
def list_operating_expenses():
    cid = session["clinic_id"]
    res = db.table("operating_expenses").select("*").eq("clinic_id", cid) \
        .order("starts_on", desc=True).execute()
    return ok(res.data or [])


@app.route("/api/operating-expenses", methods=["POST"])
@_auth(setting="recept_edit_financials")
def create_operating_expense():
    cid = session["clinic_id"]
    uid = session["user_id"]
    body = request.get_json() or {}
    name = (body.get("name") or "").strip()
    if not name:
        return err("name is required")
    row = {
        "clinic_id": cid,
        "name": name,
        "expense_type": body.get("expense_type") or "misc",
        "frequency": body.get("frequency") or "monthly",
        "amount": _float_val(body.get("amount")),
        "starts_on": body.get("starts_on") or today_str(),
        "is_active": body.get("is_active", True),
        "notes": body.get("notes"),
        "created_by": uid,
    }
    res = db.table("operating_expenses").insert(row).execute()
    _write_audit(cid, uid, "create", "operating_expense", res.data[0]["id"], new_value=res.data[0])
    return ok(res.data[0]), 201


@app.route("/api/reports/export/excel", methods=["GET"])
@limiter.limit("20 per hour")
@_auth(setting="recept_export_reports", export=True)
def export_excel_data():
    """Returns JSON rows that the frontend SheetJS uses to build the Excel file."""
    cid       = session["clinic_id"]
    date_from = request.args.get("from", date.today().replace(day=1).isoformat())
    date_to   = request.args.get("to",   today_str())

    visits = db.table("visits").select("*").eq("clinic_id", cid) \
        .gte("visit_date", date_from).lte("visit_date", date_to) \
        .order("visit_date", desc=True).execute()

    rows = visits.data or []
    patient_ids = list({r["patient_id"] for r in rows})
    patients_map = {}
    if patient_ids:
        pres = db.table("patients").select("id,full_name,phone,age,gender") \
            .eq("clinic_id", cid).in_("id", patient_ids).execute()
        patients_map = {p["id"]: p for p in (pres.data or [])}

    export_rows = []
    for r in rows:
        p = patients_map.get(r["patient_id"], {})
        export_rows.append({
            "Date":        r["visit_date"],
            "Patient":     p.get("full_name"),
            "Phone":       p.get("phone"),
            "Age":         p.get("age"),
            "Gender":      p.get("gender"),
            "Lens Type":   r.get("lens_type"),
            "OD SPH":      r.get("od_sphere"),
            "OD CYL":      r.get("od_cylinder"),
            "OD AXIS":     r.get("od_axis"),
            "OS SPH":      r.get("os_sphere"),
            "OS CYL":      r.get("os_cylinder"),
            "OS AXIS":     r.get("os_axis"),
            "IPD":         r.get("ipd"),
            "Frame":       r.get("frame_brand"),
            "Frame Price": r.get("frame_price"),
            "Lens Price":  r.get("lens_price"),
            "Checkup Fee": r.get("checkup_fee"),
            "Total":       r.get("total_amount"),
            "Paid":        r.get("amount_paid"),
            "Remaining":   r.get("remaining"),
        })

    return ok(export_rows)


@app.route("/api/reports/export/patients", methods=["GET"])
@limiter.limit("10 per hour")
@_auth(setting="recept_export_reports", export=True)
def export_all_patients():
    cid = session["clinic_id"]
    res = db.table("patients").select("*").eq("clinic_id", cid) \
        .order("full_name").execute()
    return ok(res.data or [])


# ─────────────────────────────────────────────────────────────
# SETTINGS
# ─────────────────────────────────────────────────────────────

@app.route("/api/settings", methods=["GET"])
def get_settings():
    if "user_id" not in session:
        return err("Unauthorized", 401)
    cid = session.get("clinic_id")
    cs  = db.table("clinic_settings").select("*").eq("clinic_id", cid).limit(1).execute()
    cl  = db.table("clinics").select("id,name,logo_url,phone,address,owner_email,is_banned").eq("id", cid).limit(1).execute()
    return ok({
        "clinic":   cl.data[0] if cl.data else {},
        "settings": cs.data[0] if cs.data else {},
    })


@app.route("/api/settings/repair", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def repair_settings():
    """
    Idempotent repair: ensures clinic_settings row exists with all required
    NOT NULL columns populated. Safe to call multiple times.
    """
    cid = session["clinic_id"]
    existing = db.table("clinic_settings").select("clinic_id").eq("clinic_id", cid).execute()
    if existing.data:
        return ok({"repaired": False, "message": "clinic_settings row already exists"})

    defaults = {
        "clinic_id":               cid,
        "recept_view_patients":    True,
        "recept_edit_patients":    False,
        "recept_view_financials":  False,
        "recept_edit_financials":  False,
        "recept_access_inventory": False,
        "recept_export_reports":   False,
        "recept_view_audit":       False,
        "followup_months_default": 3,
        "default_checkup_fee":     0,
        "print_show_financials":   True,
        "print_logo_align":        "center",
        "print_logo_width":        120,
        "print_logo_height":       60,
        "language":                "ar",
    }
    db.table("clinic_settings").insert(defaults).execute()
    logging.info("Repaired missing clinic_settings for clinic_id=%s", cid)
    return ok({"repaired": True, "message": "clinic_settings row created with defaults"})


@app.route("/api/settings", methods=["PUT"])
@_auth(roles=["doctor", "super_admin"])
def update_settings():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    # Clinic profile fields
    clinic_fields = ["name","logo_url","phone","address"]
    clinic_upd = {k: v for k, v in body.items() if k in clinic_fields}
    if clinic_upd:
        db.table("clinics").update(clinic_upd).eq("id", cid).execute()

    # Settings fields
    settings_fields = [
        "recept_view_patients","recept_edit_patients",
        "recept_view_financials","recept_edit_financials",
        "recept_access_inventory","recept_export_reports","recept_view_audit",
        "followup_months_default","wa_template_1","wa_template_2","wa_template_3",
        "wa_pdf_send_message","wa_pdf_message",
        "print_header_text","print_certification_text","print_warning_text",
        "print_qr_url","print_show_financials","default_checkup_fee",
        "print_doctor_name","print_doctor_credentials",
        "print_logo_align","print_logo_width","print_logo_height",
        "print_logo_data","print_qr_data","print_associates",
        "language",
    ]
    settings_upd = {k: v for k, v in body.items() if k in settings_fields}
    if settings_upd:
        # Upsert — if the row is missing (e.g. older clinic), insert with safe defaults
        existing = db.table("clinic_settings").select("clinic_id").eq("clinic_id", cid).execute()
        if existing.data:
            db.table("clinic_settings").update(settings_upd).eq("clinic_id", cid).execute()
        else:
            defaults = {
                "clinic_id":               cid,
                "recept_view_patients":    True,
                "recept_edit_patients":    False,
                "recept_view_financials":  False,
                "recept_edit_financials":  False,
                "recept_access_inventory": False,
                "recept_export_reports":   False,
                "recept_view_audit":       False,
                "followup_months_default": 3,
                "default_checkup_fee":     0,
                "print_show_financials":   True,
                "print_logo_align":        "center",
                "print_logo_width":        120,
                "print_logo_height":       60,
                "language":                "ar",
            }
            defaults.update(settings_upd)
            db.table("clinic_settings").insert(defaults).execute()

    _write_audit(cid, uid, "update", "settings", cid, new_value=body)
    return ok()


# ─────────────────────────────────────────────────────────────
# BACKUP & RESTORE
# ─────────────────────────────────────────────────────────────

BACKUP_FORMAT_VERSION = "2"
BACKUP_TABLES = [
    "patients", "visits", "frames", "lenses",
    "retail_sales", "operating_expenses", "clinic_settings",
    "clinic_lens_catalog",
]

# Supabase Storage bucket — create this bucket in your Supabase dashboard
# (Storage → New bucket, name: "clinic-backups", Private access)
BACKUP_BUCKET = "clinic-backups"

def _upload_backup_to_storage(cid: str, uid: str, payload: dict) -> str:
    """
    Upload the backup payload as a JSON file to Supabase Storage.
    Returns the storage path (e.g. "abc123/2025-01-15T10:00:00Z_manual.json").
    Falls back gracefully — if storage upload fails, returns "" so the
    backup_log row is still written (just without a storage_path).
    """
    try:
        ts = now_iso().replace(":", "-").replace(".", "-")
        path = f"{cid}/{ts}_backup.json"
        body = json.dumps(payload, default=str).encode("utf-8")

        url = f"{SUPABASE_URL.rstrip('/')}/storage/v1/object/{BACKUP_BUCKET}/{path}"
        req = urllib.request.Request(
            url,
            data=body,
            headers={
                "apikey":        SUPABASE_SERVICE_KEY,
                "Authorization": f"Bearer {SUPABASE_SERVICE_KEY}",
                "Content-Type":  "application/json",
                "x-upsert":      "true",
            },
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()  # consume response
        return path
    except Exception:
        logging.exception("Backup storage upload failed — metadata still saved")
        return ""

@app.route("/api/backup", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def create_backup():
    """Create a full clinic backup.
    The payload JSON is uploaded to Supabase Storage (bucket: clinic-backups).
    Only metadata + row_counts are stored in backup_log — never the full blob.
    """
    cid = session["clinic_id"]
    uid = session["user_id"]
    role = session.get("role")

    # Trial clinics are not permitted to export their database as JSON.
    if role != "super_admin":
        lic_state = _license_state(cid)
        if lic_state.get("plan") == "trial":
            return err(
                "JSON export is not available during the 7-day trial. "
                "Upgrade to a paid plan to enable backups.", 403
            )

    clinic = db.table("clinics").select("*").eq("id", cid).limit(1).execute()
    if not clinic.data:
        return err("Clinic not found", 404)

    payload = {
        "_meta": {
            "format_version": BACKUP_FORMAT_VERSION,
            "app": "noor-optical",
            "clinic_id": cid,
            "created_at": now_iso(),
            "created_by": uid,
        },
        "clinic": clinic.data[0],
    }

    for table in BACKUP_TABLES:
        query = db.table(table).select("*").eq("clinic_id", cid)
        payload[table] = query.execute().data or []

    row_counts = {k: len(v) for k, v in payload.items() if isinstance(v, list)}

    # Upload payload to Supabase Storage (bucket: clinic-backups, private)
    # Only row_counts metadata is stored in backup_log — never the full blob inline.
    storage_path = _upload_backup_to_storage(cid, uid, payload)

    backup_res = db.table("backup_log").insert({
        "clinic_id":    cid,
        "created_by":   uid,
        "kind":         "manual",
        "row_counts":   row_counts,
        "storage_path": storage_path,   # path in Supabase Storage; backup_data col left NULL
        "created_at":   now_iso(),
    }).execute()

    _write_audit(cid, uid, "create", "backup", None,
                 new_value={"row_counts": row_counts})

    return ok({
        "backup_id":  backup_res.data[0]["id"] if backup_res.data else None,
        "created_at": payload["_meta"]["created_at"],
        "row_counts": row_counts,
        "backup":     payload,          # still returned to caller for download
    })


@app.route("/api/backup/history", methods=["GET"])
@_auth(roles=["doctor", "super_admin"])
def backup_history():
    """List past backups for this clinic (metadata only, no backup_data blob)."""
    cid = session["clinic_id"]
    res = (
        db.table("backup_log")
        .select("id,clinic_id,created_by,kind,row_counts,created_at")
        .eq("clinic_id", cid)
        .order("created_at", desc=True)
        .limit(50)
        .execute()
    )
    return ok(res.data or [])


@app.route("/api/backup/<backup_id>/download", methods=["GET"])
@_auth(roles=["doctor", "super_admin"])
def download_backup(backup_id):
    """Return the full backup payload for a specific backup_id."""
    cid = session["clinic_id"]
    res = (
        db.table("backup_log")
        .select("*")
        .eq("id", backup_id)
        .eq("clinic_id", cid)
        .limit(1)
        .execute()
    )
    if not res.data:
        return err("Backup not found", 404)
    return ok(res.data[0])


@app.route("/api/restore", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def restore_backup():
    """
    Restore clinic data from a backup JSON.
    Strategy: upsert (insert or update by id) so existing records are
    updated and missing records are re-created.  Records not in the backup
    are left untouched — this is a *merge* restore, not a wipe-and-replace,
    which is safer for SaaS multi-tenant use.
    Pass { confirm: true } to proceed, otherwise returns a dry-run summary.
    """
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    backup = body.get("backup")
    confirm = bool(body.get("confirm", False))

    if isinstance(backup, dict):
        if isinstance(backup.get("backup"), dict):
            backup = backup["backup"]
        elif isinstance(backup.get("data"), dict) and isinstance(backup["data"].get("backup"), dict):
            backup = backup["data"]["backup"]
        elif isinstance(backup.get("backup_data"), dict):
            backup = backup["backup_data"]
        elif isinstance(backup.get("data"), dict) and isinstance(backup["data"].get("backup_data"), dict):
            backup = backup["data"]["backup_data"]

    if not backup or not isinstance(backup, dict):
        return err("No backup data provided", 400)

    meta = backup.get("_meta", {})
    fmt  = meta.get("format_version")
    src_clinic = meta.get("clinic_id")

    # Accept backups that have no _meta (e.g. older admin exports) by treating them as v1-compatible
    if fmt and fmt != BACKUP_FORMAT_VERSION:
        return err(f"Unsupported backup format version: {fmt}. Expected {BACKUP_FORMAT_VERSION}.", 400)

    if src_clinic and src_clinic != cid:
        return err("This backup belongs to a different clinic. Restore is not permitted.", 403)

    # Build summary
    summary = {}
    for table in BACKUP_TABLES:
        rows = backup.get(table, [])
        summary[table] = len(rows)

    if not confirm:
        return ok({"dry_run": True, "summary": summary, "meta": meta})

    # ── Perform restore ──
    errors = []
    restored = {}

    for table in BACKUP_TABLES:
        rows = backup.get(table, [])
        if not rows:
            restored[table] = 0
            continue

        # Strip any rows that don't belong to this clinic
        safe_rows = [r for r in rows if r.get("clinic_id") == cid]

        if not safe_rows:
            restored[table] = 0
            continue

        try:
            conflict_key = "clinic_id" if table == "clinic_settings" else ("clinic_id,category,value" if table == "clinic_lens_catalog" else "id")
            db.table(table).upsert(safe_rows, on_conflict=conflict_key).execute()
            restored[table] = len(safe_rows)
        except Exception as e:
            errors.append(f"{table}: {str(e)}")
            restored[table] = 0

    # Restore clinic profile fields (safe subset only)
    clinic_backup = backup.get("clinic", {})
    if clinic_backup:
        safe_clinic = {k: clinic_backup[k] for k in
                       ("name", "logo_url", "phone", "address")
                       if k in clinic_backup}
        if safe_clinic:
            try:
                db.table("clinics").update(safe_clinic).eq("id", cid).execute()
            except Exception as e:
                errors.append(f"clinic profile: {str(e)}")

    # Log the restore event
    db.table("backup_log").insert({
        "clinic_id": cid,
        "created_by": uid,
        "kind": "restore",
        "row_counts": restored,
        "created_at": now_iso(),
    }).execute()

    _write_audit(cid, uid, "create", "restore", None,
                 new_value={"restored": restored, "errors": errors})

    if errors:
        return jsonify({"ok": False, "restored": restored, "errors": errors}), 207

    return ok({"restored": restored, "errors": []})


# ─────────────────────────────────────────────────────────────
# USERS
# ─────────────────────────────────────────────────────────────

@app.route("/api/users", methods=["GET"])
@_auth(roles=["doctor", "super_admin"])
def list_users():
    cid = session["clinic_id"]
    res = db.table("users").select("id,full_name,username,role,is_active,last_login,created_at") \
        .eq("clinic_id", cid).neq("role", "super_admin").execute()
    return ok(res.data or [])


@app.route("/api/users", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def create_user():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    username  = (body.get("username") or "").strip()
    password  = body.get("password") or ""
    full_name = (body.get("full_name") or "").strip()
    role      = body.get("role", "receptionist")

    if not username or not password or not full_name:
        return err("username, password, and full_name are required")

    if role == "super_admin":
        return err("Cannot create super_admin through this endpoint", 403)

    # Check username unique within clinic
    existing = db.table("users").select("id").eq("clinic_id", cid).eq("username", username).execute()
    if existing.data:
        return err("Username already exists")

    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()

    row = {
        "clinic_id":            cid,
        "username":             username,
        "password_hash":        hashed,
        "full_name":            full_name,
        "role":                 role,
        "is_active":            True,
        "must_change_password": True,
        "created_at":           now_iso(),
    }
    res = db.table("users").insert(row).execute()
    user = {k: v for k, v in res.data[0].items() if k != "password_hash"}
    _write_audit(cid, uid, "create", "user", user["id"], new_value={"username": username, "role": role})
    return ok(user), 201


@app.route("/api/users/<target_id>", methods=["PUT"])
@_auth(roles=["doctor", "super_admin"])
def update_user(target_id):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    target = db.table("users").select("*").eq("clinic_id", cid).eq("id", target_id).limit(1).execute()
    if not target.data:
        return err("User not found", 404)
    target_row = target.data[0]
    if target_row["role"] == "super_admin":
        return err("Cannot modify super_admin", 403)

    updates = {}
    if "full_name" in body:
        updates["full_name"] = body["full_name"]
    if "is_active" in body:
        updates["is_active"] = bool(body["is_active"])
    if "password" in body:
        pw = body["password"]
        if len(pw) < 8:
            return err("Password too short (minimum 8 characters)")
        updates["password_hash"]        = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
        updates["must_change_password"] = False

    if not updates:
        return err("Nothing to update")

    res = db.table("users").update(updates).eq("clinic_id", cid).eq("id", target_id).execute()
    _write_audit(cid, uid, "update", "user", target_id)
    return ok({k: v for k, v in res.data[0].items() if k != "password_hash"})


@app.route("/api/users/<target_id>/reset-password", methods=["POST"])
@_auth(roles=["doctor", "super_admin"])
def reset_user_password(target_id):
    """Doctor (or super_admin) resets a receptionist's password."""
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    new_pw = body.get("password", "")
    if len(new_pw) < 8:
        return err("Password must be at least 8 characters")

    target = db.table("users").select("id,role,full_name").eq("clinic_id", cid).eq("id", target_id).limit(1).execute()
    if not target.data:
        return err("User not found", 404)
    target_row = target.data[0]
    if target_row["role"] == "super_admin":
        return err("Cannot modify super_admin", 403)
    # Doctors can only reset receptionist passwords (not other doctors)
    if session.get("role") == "doctor" and target_row["role"] not in ("receptionist",):
        return err("Doctors can only reset receptionist passwords", 403)

    hashed = bcrypt.hashpw(new_pw.encode(), bcrypt.gensalt()).decode()
    db.table("users").update({
        "password_hash":        hashed,
        "must_change_password": True,
    }).eq("clinic_id", cid).eq("id", target_id).execute()

    _write_audit(cid, uid, "update", "user", target_id,
                 new_value={"action": "password_reset", "target": target_row.get("full_name")})
    return ok()



@_auth(roles=["doctor", "super_admin"])
def delete_user(target_id):
    cid = session["clinic_id"]
    uid = session["user_id"]

    if target_id == uid:
        return err("Cannot delete yourself", 400)

    target = db.table("users").select("role").eq("clinic_id", cid).eq("id", target_id).limit(1).execute()
    if not target.data:
        return err("User not found", 404)
    if target.data[0]["role"] == "super_admin":
        return err("Cannot delete super_admin", 403)

    db.table("users").delete().eq("clinic_id", cid).eq("id", target_id).execute()
    _write_audit(cid, uid, "delete", "user", target_id)
    return ok()


# ─────────────────────────────────────────────────────────────
# AUDIT LOG
# ─────────────────────────────────────────────────────────────

@app.route("/api/audit", methods=["GET"])
@_auth(setting="recept_view_audit")
def list_audit():
    cid       = session["clinic_id"]
    date_from = request.args.get("from")
    date_to   = request.args.get("to")
    action    = request.args.get("action")
    limit     = min(200, int(request.args.get("limit", 100)))

    query = db.table("audit_log").select(
        "id,action,entity_type,entity_id,created_at,details,user_id"
    ).eq("clinic_id", cid)

    if date_from:
        query = query.gte("created_at", date_from + "T00:00:00")
    if date_to:
        query = query.lte("created_at", date_to + "T23:59:59")
    if action:
        query = query.eq("action", action)

    res = query.order("created_at", desc=True).limit(limit).execute()
    rows = res.data or []

    # Attach usernames
    user_ids = list({r["user_id"] for r in rows if r.get("user_id")})
    users_map = {}
    if user_ids:
        ures = db.table("users").select("id,username,full_name") \
            .in_("id", user_ids).execute()
        users_map = {u["id"]: u for u in (ures.data or [])}

    for r in rows:
        u = users_map.get(r.get("user_id"), {})
        r["username"]  = u.get("username")
        r["full_name"] = u.get("full_name")

    return ok(rows)


# ─────────────────────────────────────────────────────────────
# SUPER ADMIN PANEL
# ─────────────────────────────────────────────────────────────

def _require_super(f):
    """Extra guard: only super_admin can call these endpoints."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        if session.get("role") != "super_admin":
            return err("Forbidden", 403)
        return f(*args, **kwargs)
    return wrapper


@app.route("/api/admin/clinics", methods=["GET"])
@_auth()
@_require_super
def admin_list_clinics():
    clinics = db.table("clinics").select("*").order("created_at", desc=True).execute()
    clinic_list = clinics.data or []

    for c in clinic_list:
        lic = db.table("licenses").select("plan,expires_at,is_active") \
            .eq("clinic_id", c["id"]).eq("is_active", True).order("created_at", desc=True).limit(1).execute()
        c["license"] = lic.data[0] if lic.data else None
        users = db.table("users").select("id,email,username,full_name,role,is_active,last_login,created_at") \
            .eq("clinic_id", c["id"]).execute()
        c["users"] = users.data or []

    return ok(clinic_list)


@app.route("/api/admin/clinics", methods=["POST"])
@_auth()
@_require_super
def admin_create_clinic():
    body = request.get_json() or {}
    name      = (body.get("name") or "").strip()
    username  = (body.get("doctor_username") or "").strip()
    password  = body.get("doctor_password") or ""
    owner_email = (body.get("owner_email") or body.get("email") or "").strip().lower()
    plan      = body.get("plan", "trial")
    full_name = body.get("doctor_full_name") or name + " Doctor"

    if not name or not username or not password:
        return err("name, doctor_username, doctor_password are required")

    # Create clinic
    clinic_res = db.table("clinics").insert({
        "name":       name,
        "phone":      body.get("phone"),
        "owner_email": owner_email or None,
        "address":    body.get("address"),
        "created_at": now_iso(),
    }).execute()
    clinic = clinic_res.data[0]
    cid = clinic["id"]

    # Create default clinic_settings
    db.table("clinic_settings").insert({
        "clinic_id":               cid,
        "followup_months_default": 3,
        "recept_view_patients":    True,
        "recept_edit_patients":    False,
        "recept_view_financials":  False,
        "recept_edit_financials":  False,
        "recept_access_inventory": False,
        "recept_export_reports":   False,
        "recept_view_audit":       False,
        "default_checkup_fee":      body.get("default_checkup_fee") or 0,
        "print_show_financials":    True,
        "wa_template_1":           "Dear {patient_name}, your next visit at {clinic_name} is on {next_visit}.",
        "wa_template_2":           "Hello {patient_name}! Time for your annual eye check at {clinic_name}.",
        "wa_template_3":           "{patient_name}, follow-up reminder: {next_visit}. {clinic_name}.",
    }).execute()

    # Create license
    plan_days = {"trial": 7, "monthly": 30, "quarterly": 90, "yearly": 365}
    if plan == "lifetime":
        expires_at = None
    else:
        expires_at = (date.today() + timedelta(days=plan_days.get(plan, 7))).isoformat()

    db.table("licenses").insert({
        "clinic_id":  cid,
        "plan":       plan,
        "starts_at":  today_str(),
        "expires_at": expires_at,
        "is_active":  True,
    }).execute()

    # Create doctor user
    hashed = bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()
    db.table("users").insert({
        "clinic_id":            cid,
        "username":             username,
        "email":                owner_email or None,
        "password_hash":        hashed,
        "full_name":            full_name,
        "role":                 "doctor",
        "is_active":            True,
        "must_change_password": True,
        "created_at":           now_iso(),
    }).execute()

    return ok(clinic), 201


@app.route("/api/admin/clinics/<cid>", methods=["PUT"])
@_auth()
@_require_super
def admin_update_clinic(cid):
    body = request.get_json() or {}
    allowed = ["name","phone","address","logo_url","owner_email","is_banned","banned_reason"]
    updates = {k: v for k, v in body.items() if k in allowed}
    if "is_banned" in updates:
        updates["is_banned"] = bool(updates["is_banned"])
        updates["banned_at"] = now_iso() if updates["is_banned"] else None
    if updates:
        db.table("clinics").update(updates).eq("id", cid).execute()
    return ok()


@app.route("/api/admin/clinics/<cid>", methods=["DELETE"])
@_auth()
@_require_super
def admin_delete_clinic(cid):
    if cid == session.get("clinic_id"):
        return err("Cannot delete the clinic you are currently using", 400)
    db.table("clinics").delete().eq("id", cid).execute()
    return ok()


@app.route("/api/admin/clinics/<cid>/stats", methods=["GET"])
@_auth()
@_require_super
def admin_clinic_stats(cid):
    patient_count = db.table("patients").select("id", count="exact").eq("clinic_id", cid).execute()
    visit_count   = db.table("visits").select("id",   count="exact").eq("clinic_id", cid).execute()
    revenue       = db.table("visits").select("amount_paid").eq("clinic_id", cid).execute()
    total_rev     = sum(v.get("amount_paid", 0) or 0 for v in (revenue.data or []))

    return ok({
        "patients": patient_count.count,
        "visits":   visit_count.count,
        "revenue":  total_rev,
    })


@app.route("/api/admin/impersonate/<target_clinic_id>", methods=["POST"])
@_auth()
@_require_super
def admin_impersonate(target_clinic_id):
    """Let super_admin act as a clinic (sets clinic_id in session, role stays super_admin)."""
    c = db.table("clinics").select("id,name").eq("id", target_clinic_id).limit(1).execute()
    if not c.data:
        return err("Clinic not found", 404)
    clinic_row = c.data[0]
    session["clinic_id"]         = target_clinic_id
    session["impersonating"]     = True
    session["impersonating_name"] = clinic_row["name"]
    return ok({"clinic": clinic_row})


@app.route("/api/admin/impersonate/stop", methods=["POST"])
@_auth()
@_require_super
def admin_stop_impersonate():
    session.pop("clinic_id", None)
    session.pop("impersonating", None)
    session.pop("impersonating_name", None)
    return ok()


@app.route("/api/admin/licenses", methods=["GET"])
@_auth()
@_require_super
def admin_list_licenses():
    res = db.table("licenses").select("*").order("starts_at", desc=True).execute()
    return ok(res.data or [])


@app.route("/api/admin/licenses/<target_clinic_id>", methods=["PUT"])
@_auth()
@_require_super
def admin_update_license(target_clinic_id):
    body  = request.get_json() or {}
    plan  = body.get("plan")
    notes = (body.get("notes") or "").strip()

    # Allow admin to set an explicit start date; fall back to today
    raw_starts = (body.get("starts_at") or "").strip()
    try:
        starts_at = date.fromisoformat(raw_starts).isoformat() if raw_starts else today_str()
    except ValueError:
        return err("Invalid starts_at date format. Use YYYY-MM-DD.", 400)

    KNOWN_PLANS = {"trial", "monthly", "quarterly", "yearly", "lifetime", "custom"}
    if plan and plan not in KNOWN_PLANS:
        return err(f"Unknown plan '{plan}'.", 400)

    plan_days = {"trial": 7, "monthly": 30, "quarterly": 90, "yearly": 365}

    if plan == "lifetime":
        expires_at = None
    elif plan == "custom":
        raw_exp = (body.get("expires_at") or "").strip()
        if not raw_exp:
            return err("expires_at is required for a custom plan.", 400)
        try:
            expires_at = date.fromisoformat(raw_exp).isoformat()
        except ValueError:
            return err("Invalid expires_at date format. Use YYYY-MM-DD.", 400)
    elif plan in plan_days:
        base = date.fromisoformat(starts_at)
        expires_at = (base + timedelta(days=plan_days[plan])).isoformat()
    else:
        raw_exp = (body.get("expires_at") or "").strip()
        try:
            expires_at = date.fromisoformat(raw_exp).isoformat() if raw_exp else None
        except ValueError:
            return err("Invalid expires_at date format. Use YYYY-MM-DD.", 400)

    new_row = {
        "clinic_id":  target_clinic_id,
        "is_active":  True,
        "starts_at":  starts_at,
        "expires_at": expires_at,
    }
    if plan:
        new_row["plan"] = plan
    if notes:
        new_row["notes"] = notes

    try:
        db.table("licenses").update({"is_active": False}).eq("clinic_id", target_clinic_id).execute()
        db.table("licenses").insert(new_row).execute()
    except Exception as exc:
        logging.exception("admin_update_license failed for clinic %s", target_clinic_id)
        return err(f"Failed to update license: {str(exc)}", 500)

    return ok({"starts_at": starts_at, "expires_at": expires_at, "plan": plan})


@app.route("/api/admin/clinics/<cid>/backup", methods=["POST"])
@_auth()
@_require_super
def admin_backup_clinic(cid):
    clinic = db.table("clinics").select("*").eq("id", cid).limit(1).execute()
    if not clinic.data:
        return err("Clinic not found", 404)

    payload = {
        "_meta": {
            "format_version": BACKUP_FORMAT_VERSION,
            "app": "noor-optical",
            "clinic_id": cid,
            "created_at": now_iso(),
            "created_by": session.get("user_id"),
            "source": "admin",
        },
        "clinic": clinic.data[0],
    }
    for table in ["patients", "visits", "frames", "lenses", "clinic_lens_catalog", "retail_sales", "operating_expenses", "users", "clinic_settings", "licenses"]:
        payload[table] = db.table(table).select("*").eq("clinic_id", cid).execute().data or []

    row_counts = {k: len(v) for k, v in payload.items() if isinstance(v, list)}

    storage_path = _upload_backup_to_storage(cid, session.get("user_id"), payload)
    backup_res = db.table("backup_log").insert({
        "clinic_id":    cid,
        "created_by":   session.get("user_id"),
        "kind":         "manual",
        "row_counts":   row_counts,
        "storage_path": storage_path,
        "created_at":   now_iso(),
    }).execute()

    return ok({
        "backup_id": backup_res.data[0]["id"] if backup_res.data else None,
        "created_at": now_iso(),
        "row_counts": row_counts,
        "backup": payload,
    })


@app.route("/api/admin/audit", methods=["GET"])
@_auth()
@_require_super
def admin_global_audit():
    limit = min(500, int(request.args.get("limit", 100)))
    res = db.table("audit_log").select("*").order("created_at", desc=True).limit(limit).execute()
    return ok(res.data or [])


# ─────────────────────────────────────────────────────────────
# ERROR HANDLERS
# ─────────────────────────────────────────────────────────────

@app.errorhandler(404)
def not_found(e):
    return err("Not found", 404)

@app.errorhandler(405)
def method_not_allowed(e):
    return err("Method not allowed", 405)

@app.errorhandler(500)
def internal_error(e):
    tb = traceback.format_exc()
    logging.error(tb)
    if app.debug:
        return jsonify({"error": "Internal server error", "detail": str(e), "traceback": tb}), 500
    return jsonify({"error": "Internal server error"}), 500

@app.errorhandler(Exception)
def unhandled_exception(e):
    tb = traceback.format_exc()
    logging.error(tb)
    if app.debug:
        return jsonify({"error": str(e), "traceback": tb}), 500
    return jsonify({"error": "Internal server error"}), 500


# ─────────────────────────────────────────────────────────────
# ENTRY POINT (local dev only — Vercel uses WSGI)
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(debug=True, port=5000)
