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

logging.basicConfig(level=logging.DEBUG)

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

# Allow the frontend to send cookies cross-origin on Vercel
CORS(app, supports_credentials=True, origins=[
    "https://noor-optical-management-n8tgntf5n-1jaky.vercel.app",
    "http://localhost:5000",
    "http://127.0.0.1:5000",
])

limiter = Limiter(
    get_remote_address,
    app=app,
    default_limits=["300 per hour"],
    storage_uri=os.environ.get("RATELIMIT_STORAGE_URI", "memory://"),
)

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
    return datetime.utcnow().isoformat()

def today_str():
    return date.today().isoformat()

def err(msg, code=400):
    return jsonify({"error": msg}), code

def ok(data=None, **kwargs):
    payload = {"ok": True}
    if data is not None:
        payload["data"] = data
    payload.update(kwargs)
    return jsonify(payload)

WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _csrf_token():
    token = session.get("csrf_token")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf_token"] = token
    return token


def _safe_license_summary(license_state):
    return {
        "status": license_state["status"],
        "plan": license_state.get("plan"),
        "days_left": license_state.get("days_left"),
        "read_only": license_state["status"] in ("expired_read_only", "blocked"),
        "exports_allowed": license_state["status"] == "active",
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
    res = db.table("clinics").select("is_banned").eq("id", clinic_id).single().execute()
    return bool(res.data and res.data.get("is_banned"))


def _license_state(clinic_id):
    """
    Backend-only license decision.
    status values: active, trial, expired_read_only, blocked.
    """
    res = db.table("licenses") \
        .select("*") \
        .eq("clinic_id", clinic_id) \
        .eq("is_active", True) \
        .order("starts_at", desc=True) \
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
        status = "trial" if plan == "trial" else "active"
        return {"status": status, "plan": plan, "days_left": delta}

    # Expired clinics keep read access only. No write grace period.
    return {"status": "expired_read_only", "plan": plan, "days_left": delta}


@app.before_request
def _csrf_protect():
    if request.method not in WRITE_METHODS:
        return None
    if request.endpoint in {"login", "signup", "reset_password"}:
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
    db.table("audit_log").insert({
        "clinic_id":   clinic_id,
        "user_id":     user_id,
        "action":      action,
        "entity_type": entity_type,
        "entity_id":   entity_id,
        "old_value":   old_value,
        "new_value":   new_value,
        "created_at":  now_iso(),
    }).execute()


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
            if expires_at and datetime.fromisoformat(expires_at) < datetime.utcnow():
                session.clear()
                return err("Session expired", 401)

            role = session.get("role")
            clinic_id = session.get("clinic_id")

            if session.get("must_change_password") and request.endpoint != "change_password":
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
            if export and status != "active":
                return err("Export is available only for active paid clinics.", 403)
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
                cs_res = db.table("clinic_settings") \
                    .select(setting) \
                    .eq("clinic_id", clinic_id) \
                    .single() \
                    .execute()
                if not cs_res.data or not cs_res.data.get(setting):
                    return err("Permission denied", 403)

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

    # Build session
    session.permanent = True
    session["user_id"]   = user["id"]
    session["role"]      = role
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat()
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

    if not clinic_name or not owner_name or not email or len(password) < 6:
        return err("clinic_name, owner_name, email, and a 6+ character password are required")

    existing = db.table("users").select("id").eq("email", email).limit(1).execute()
    if existing.data:
        return err("An account already exists for this email", 409)

    try:
        auth_res = _auth_rest("signup", {"email": email, "password": password})
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
        _auth_rest("recover", {"email": email})
    except Exception:
        logging.exception("Supabase reset password failed")
    return ok({"message": "If the email exists, a reset link has been sent."})


@app.route("/api/me", methods=["GET"])
def me():
    if "user_id" not in session:
        return err("Unauthorized", 401)

    expires_at = session.get("expires_at")
    if expires_at and datetime.fromisoformat(expires_at) < datetime.utcnow():
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
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat()

    return ok({
        "user_id":              session["user_id"],
        "clinic_id":            clinic_id,
        "role":                 role,
        "must_change_password": bool(session.get("must_change_password", False)),
        "grace_warning":        grace_warning,
        "csrf_token":           _csrf_token(),
        "license":              license_summary,
    })


@app.route("/api/change-password", methods=["POST"])
@_auth(allow_readonly_write=True)
def change_password():
    body = request.get_json() or {}
    new_pw = body.get("password", "")
    if len(new_pw) < 6:
        return err("Password must be at least 6 characters")

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
    limit  = min(100, int(request.args.get("limit", 50)))
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

    return ok(rows, total=total, page=page, limit=limit)


@app.route("/api/patients", methods=["POST"])
@_auth(roles=["doctor", "super_admin", "receptionist"], setting="recept_edit_patients")
def create_patient():
    cid  = session.get("clinic_id")
    uid  = session.get("user_id")
    if not cid:
        return err("No clinic assigned to this account. Please contact the administrator.", 400)
    body = request.get_json() or {}

    full_name = (body.get("full_name") or "").strip()
    if not full_name:
        return err("full_name is required")

    row = {
        "clinic_id":  cid,
        "full_name":  full_name,
        "phone":      body.get("phone"),
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
    res = db.table("patients").select("*").eq("clinic_id", cid).eq("id", pid).single().execute()
    if not res.data:
        return err("Patient not found", 404)

    visits = db.table("visits").select("*").eq("clinic_id", cid) \
        .eq("patient_id", pid).order("visit_date", desc=True).execute()

    return ok({**res.data, "visits": visits.data or []})


@app.route("/api/patients/<pid>", methods=["PUT"])
@_auth(setting="recept_edit_patients")
def update_patient(pid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("patients").select("*").eq("clinic_id", cid).eq("id", pid).single().execute()
    if not old.data:
        return err("Patient not found", 404)

    allowed = ["full_name","phone","age","gender","address","notes"]
    updates = {k: v for k, v in body.items() if k in allowed}
    updates["updated_at"] = now_iso()

    res = db.table("patients").update(updates).eq("clinic_id", cid).eq("id", pid).execute()
    _write_audit(cid, uid, "update", "patient", pid, old_value=old.data, new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/patients/<pid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_patient(pid):
    cid = session["clinic_id"]
    uid = session["user_id"]

    old = db.table("patients").select("id,full_name").eq("clinic_id", cid).eq("id", pid).single().execute()
    if not old.data:
        return err("Patient not found", 404)

    # Cascade delete visits
    db.table("visits").delete().eq("clinic_id", cid).eq("patient_id", pid).execute()
    db.table("patients").delete().eq("clinic_id", cid).eq("id", pid).execute()

    _write_audit(cid, uid, "delete", "patient", pid, old_value=old.data)
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
    p = db.table("patients").select("id").eq("clinic_id", cid).eq("id", patient_id).single().execute()
    if not p.data:
        return err("Patient not found", 404)

    # Plano guard — force zero power if lens_type == plano
    lens_type = body.get("lens_type", "single_vision")
    if lens_type == "plano":
        for fld in ["od_sphere","od_cylinder","os_sphere","os_cylinder"]:
            body[fld] = 0

    frame_price   = float(body.get("frame_price", 0) or 0)
    lens_price    = float(body.get("lens_price", 0) or 0)
    checkup_fee   = float(body.get("checkup_fee", 0) or 0)
    total_amount  = frame_price + lens_price + checkup_fee
    amount_paid   = float(body.get("amount_paid", 0) or 0)
    remaining     = max(0, total_amount - amount_paid)

    row = {
        "clinic_id":     cid,
        "patient_id":    patient_id,
        "visit_date":    body.get("visit_date") or today_str(),
        # Rx OD
        "od_sphere":     body.get("od_sphere"),
        "od_cylinder":   body.get("od_cylinder"),
        "od_axis":       body.get("od_axis"),
        "od_addition":   body.get("od_addition"),
        "od_va":         body.get("od_va"),
        "od_bcva":       body.get("od_bcva"),
        # Rx OS
        "os_sphere":     body.get("os_sphere"),
        "os_cylinder":   body.get("os_cylinder"),
        "os_axis":       body.get("os_axis"),
        "os_addition":   body.get("os_addition"),
        "os_va":         body.get("os_va"),
        "os_bcva":       body.get("os_bcva"),
        # Shared
        "ipd":           body.get("ipd"),
        # Lens config
        "lens_type":     lens_type,
        "lens_material": body.get("lens_material"),
        "lens_coating":  body.get("lens_coating"),
        "lens_count":    body.get("lens_count", 2),
        # Frame
        "frame_id":      body.get("frame_id"),
        "frame_brand":   body.get("frame_brand"),
        "frame_type":    body.get("frame_type"),
        "frame_material":body.get("frame_material"),
        # Checkup
        "did_checkup":       body.get("did_checkup", False),
        "next_visit_date":   body.get("next_visit_date"),
        "followup_months":   body.get("followup_months", 3),
        # Financials
        "frame_cost":    body.get("frame_cost"),
        "frame_price":   frame_price,
        "lens_cost":     body.get("lens_cost"),
        "lens_price":    lens_price,
        "checkup_fee":   checkup_fee,
        "total_amount":  total_amount,
        "amount_paid":   amount_paid,
        "remaining":     remaining,
        "notes":         body.get("notes"),
        "created_by":    uid,
    }

    # ── Inventory deduction (transactional guard) ──
    lens_id  = body.get("lens_id")
    frame_id = body.get("frame_id")
    lens_count = int(body.get("lens_count", 2))

    if lens_id:
        l = db.table("lenses").select("quantity,min_stock").eq("clinic_id", cid).eq("id", lens_id).single().execute()
        if l.data:
            new_qty = max(0, l.data["quantity"] - lens_count)
            # Stock guard: can't use 2 of a qty-1 lens
            if l.data["quantity"] < lens_count:
                return err(f"Insufficient lens stock (have {l.data['quantity']}, need {lens_count})", 409)
            db.table("lenses").update({"quantity": new_qty}).eq("clinic_id", cid).eq("id", lens_id).execute()

    if frame_id:
        f = db.table("frames").select("quantity").eq("clinic_id", cid).eq("id", frame_id).single().execute()
        if f.data:
            if f.data["quantity"] < 1:
                return err("Frame out of stock", 409)
            db.table("frames").update({"quantity": f.data["quantity"] - 1}).eq("clinic_id", cid).eq("id", frame_id).execute()

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
    res = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).single().execute()
    if not res.data:
        return err("Visit not found", 404)
    return ok(res.data)


@app.route("/api/visits/<vid>/print", methods=["GET"])
@_auth(setting="recept_view_patients")
def get_visit_print_payload(vid):
    cid = session["clinic_id"]
    visit = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).single().execute()
    if not visit.data:
        return err("Visit not found", 404)

    patient = db.table("patients").select("*").eq("clinic_id", cid) \
        .eq("id", visit.data["patient_id"]).single().execute()
    clinic = db.table("clinics").select("id,name,logo_url,phone,address").eq("id", cid).single().execute()
    settings = db.table("clinic_settings").select("*").eq("clinic_id", cid).single().execute()

    return ok({
        "visit": visit.data,
        "patient": patient.data,
        "clinic": clinic.data,
        "settings": settings.data,
    })


@app.route("/api/visits/<vid>", methods=["PUT"])
@_auth(setting="recept_edit_financials")
def update_visit(vid):
    cid  = session["clinic_id"]
    uid  = session["user_id"]
    body = request.get_json() or {}

    old = db.table("visits").select("*").eq("clinic_id", cid).eq("id", vid).single().execute()
    if not old.data:
        return err("Visit not found", 404)

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
        fp   = float(updates.get("frame_price",  old.data.get("frame_price",  0)) or 0)
        lp   = float(updates.get("lens_price",   old.data.get("lens_price",   0)) or 0)
        cf   = float(updates.get("checkup_fee",  old.data.get("checkup_fee",  0)) or 0)
        paid = float(updates.get("amount_paid",  old.data.get("amount_paid",  0)) or 0)
        updates["total_amount"] = fp + lp + cf
        updates["remaining"]    = max(0, updates["total_amount"] - paid)

    # Plano guard
    if updates.get("lens_type") == "plano":
        for fld in ["od_sphere","od_cylinder","os_sphere","os_cylinder"]:
            updates[fld] = 0

    res = db.table("visits").update(updates).eq("clinic_id", cid).eq("id", vid).execute()
    _write_audit(cid, uid, "update", "visit", vid, old_value=old.data, new_value=res.data[0])
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
        "id,patient_id,visit_date,next_visit_date,lens_type"
    ).eq("clinic_id", cid).lte("next_visit_date", cutoff).not_.is_("next_visit_date", "null") \
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

    row = {
        "clinic_id":  cid,
        "lens_type":  body.get("lens_type"),
        "material":   body.get("material"),
        "coating":    body.get("coating", "clear"),
        "sphere":     body.get("sphere"),
        "cylinder":   body.get("cylinder", 0),
        "quantity":   int(body.get("quantity", 0)),
        "min_stock":  int(body.get("min_stock", 2)),
        "cost_price": body.get("cost_price"),
        "sell_price": body.get("sell_price"),
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

    old = db.table("lenses").select("*").eq("clinic_id", cid).eq("id", lid).single().execute()
    if not old.data:
        return err("Lens not found", 404)

    allowed = ["lens_type","material","coating","sphere","cylinder","quantity","min_stock","cost_price","sell_price"]
    updates = {k: v for k, v in body.items() if k in allowed}
    updates["updated_at"] = now_iso()

    res = db.table("lenses").update(updates).eq("clinic_id", cid).eq("id", lid).execute()
    _write_audit(cid, uid, "update", "lens", lid, old_value=old.data, new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/lenses/<lid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_lens(lid):
    cid = session["clinic_id"]
    uid = session["user_id"]
    old = db.table("lenses").select("*").eq("clinic_id", cid).eq("id", lid).single().execute()
    if not old.data:
        return err("Lens not found", 404)
    db.table("lenses").delete().eq("clinic_id", cid).eq("id", lid).execute()
    _write_audit(cid, uid, "delete", "lens", lid, old_value=old.data)
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

    l = db.table("lenses").select("quantity").eq("clinic_id", cid).eq("id", lid).single().execute()
    if not l.data:
        return err("Lens not found", 404)

    new_qty = l.data["quantity"] + qty
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

    old = db.table("frames").select("*").eq("clinic_id", cid).eq("id", fid).single().execute()
    if not old.data:
        return err("Frame not found", 404)

    allowed = ["brand","frame_type","frame_material","color","quantity","min_stock","cost_price","sell_price"]
    updates = {k: v for k, v in body.items() if k in allowed}
    updates["updated_at"] = now_iso()

    res = db.table("frames").update(updates).eq("clinic_id", cid).eq("id", fid).execute()
    _write_audit(cid, uid, "update", "frame", fid, old_value=old.data, new_value=res.data[0])
    return ok(res.data[0])


@app.route("/api/frames/<fid>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_frame(fid):
    cid = session["clinic_id"]
    uid = session["user_id"]
    old = db.table("frames").select("*").eq("clinic_id", cid).eq("id", fid).single().execute()
    if not old.data:
        return err("Frame not found", 404)
    db.table("frames").delete().eq("clinic_id", cid).eq("id", fid).execute()
    _write_audit(cid, uid, "delete", "frame", fid, old_value=old.data)
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

    f = db.table("frames").select("quantity").eq("clinic_id", cid).eq("id", fid).single().execute()
    if not f.data:
        return err("Frame not found", 404)

    new_qty = f.data["quantity"] + qty
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
@_auth(setting="recept_export_reports")
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
@_auth(setting="recept_export_reports")
def list_retail_sales():
    cid = session["clinic_id"]
    date_from = request.args.get("from", date.today().replace(day=1).isoformat())
    date_to = request.args.get("to", today_str())
    res = db.table("retail_sales").select("*").eq("clinic_id", cid) \
        .gte("sale_date", date_from).lte("sale_date", date_to) \
        .order("sale_date", desc=True).execute()
    return ok(res.data or [])


@app.route("/api/retail-sales", methods=["POST"])
@_auth(setting="recept_export_reports")
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
@_auth(setting="recept_export_reports")
def list_operating_expenses():
    cid = session["clinic_id"]
    res = db.table("operating_expenses").select("*").eq("clinic_id", cid) \
        .order("starts_on", desc=True).execute()
    return ok(res.data or [])


@app.route("/api/operating-expenses", methods=["POST"])
@_auth(setting="recept_export_reports")
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
@_auth()
def get_settings():
    cid = session["clinic_id"]
    cs  = db.table("clinic_settings").select("*").eq("clinic_id", cid).single().execute()
    cl  = db.table("clinics").select("id,name,logo_url,phone,address,owner_email,is_banned").eq("id", cid).single().execute()
    return ok({
        "clinic":   cl.data,
        "settings": cs.data,
    })


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
        "print_header_text","print_certification_text","print_warning_text",
        "print_qr_url","print_show_financials","default_checkup_fee",
        "language",
    ]
    settings_upd = {k: v for k, v in body.items() if k in settings_fields}
    if settings_upd:
        # Upsert
        existing = db.table("clinic_settings").select("clinic_id").eq("clinic_id", cid).execute()
        if existing.data:
            db.table("clinic_settings").update(settings_upd).eq("clinic_id", cid).execute()
        else:
            db.table("clinic_settings").insert({"clinic_id": cid, **settings_upd}).execute()

    _write_audit(cid, uid, "update", "settings", cid, new_value=body)
    return ok()


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

    target = db.table("users").select("*").eq("clinic_id", cid).eq("id", target_id).single().execute()
    if not target.data:
        return err("User not found", 404)
    if target.data["role"] == "super_admin":
        return err("Cannot modify super_admin", 403)

    updates = {}
    if "full_name" in body:
        updates["full_name"] = body["full_name"]
    if "is_active" in body:
        updates["is_active"] = bool(body["is_active"])
    if "password" in body:
        pw = body["password"]
        if len(pw) < 6:
            return err("Password too short")
        updates["password_hash"]        = bcrypt.hashpw(pw.encode(), bcrypt.gensalt()).decode()
        updates["must_change_password"] = False

    if not updates:
        return err("Nothing to update")

    res = db.table("users").update(updates).eq("clinic_id", cid).eq("id", target_id).execute()
    _write_audit(cid, uid, "update", "user", target_id)
    return ok({k: v for k, v in res.data[0].items() if k != "password_hash"})


@app.route("/api/users/<target_id>", methods=["DELETE"])
@_auth(roles=["doctor", "super_admin"])
def delete_user(target_id):
    cid = session["clinic_id"]
    uid = session["user_id"]

    if target_id == uid:
        return err("Cannot delete yourself", 400)

    target = db.table("users").select("role").eq("clinic_id", cid).eq("id", target_id).single().execute()
    if not target.data:
        return err("User not found", 404)
    if target.data["role"] == "super_admin":
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
            .eq("clinic_id", c["id"]).order("starts_at", desc=True).limit(1).execute()
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
    c = db.table("clinics").select("id,name").eq("id", target_clinic_id).single().execute()
    if not c.data:
        return err("Clinic not found", 404)
    session["clinic_id"]         = target_clinic_id
    session["impersonating"]     = True
    session["impersonating_name"] = c.data["name"]
    return ok({"clinic": c.data})


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
    notes = body.get("notes")

    plan_days = {"trial": 7, "monthly": 30, "quarterly": 90, "yearly": 365}
    if plan == "lifetime":
        expires_at = None
    elif plan in plan_days:
        expires_at = (date.today() + timedelta(days=plan_days[plan])).isoformat()
    else:
        expires_at = body.get("expires_at")

    updates = {"is_active": True, "starts_at": today_str()}
    if plan:
        updates["plan"] = plan
    if expires_at is not None or plan == "lifetime":
        updates["expires_at"] = expires_at
    if notes:
        updates["notes"] = notes

    # Deactivate old licenses then insert new
    db.table("licenses").update({"is_active": False}).eq("clinic_id", target_clinic_id).execute()
    db.table("licenses").insert({"clinic_id": target_clinic_id, **updates}).execute()

    return ok()


@app.route("/api/admin/clinics/<cid>/backup", methods=["POST"])
@_auth()
@_require_super
def admin_backup_clinic(cid):
    clinic = db.table("clinics").select("*").eq("id", cid).single().execute()
    if not clinic.data:
        return err("Clinic not found", 404)

    payload = {"clinic": clinic.data}
    for table in ["patients", "visits", "frames", "lenses", "retail_sales", "operating_expenses", "users", "clinic_settings", "licenses"]:
        query = db.table(table).select("*")
        if table == "clinic_settings":
            query = query.eq("clinic_id", cid)
        elif table == "licenses":
            query = query.eq("clinic_id", cid)
        else:
            query = query.eq("clinic_id", cid)
        payload[table] = query.execute().data or []

    row_counts = {k: len(v) for k, v in payload.items() if isinstance(v, list)}
    backup_res = db.table("backup_log").insert({
        "clinic_id": cid,
        "created_by": session.get("user_id"),
        "kind": "manual",
        "row_counts": row_counts,
        "backup_data": payload,
        "created_at": now_iso(),
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
