"""
Noor Optical Clinic SaaS — Flask Backend
app.py — All routes, session auth, Supabase DB
"""

import os
import json
import bcrypt
from datetime import datetime, timedelta, date
from functools import wraps

from flask import Flask, request, jsonify, session
from flask_cors import CORS
from supabase import create_client, Client

# ─────────────────────────────────────────────
# APP INIT
# ─────────────────────────────────────────────
app = Flask(__name__)
app.secret_key = os.environ.get("FLASK_SECRET_KEY", "change-this-in-production")
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

def _check_license(clinic_id):
    """
    Returns (valid: bool, in_grace: bool, days_left: int|None)
    Grace period: 5 days after expiry.
    """
    res = db.table("licenses") \
        .select("*") \
        .eq("clinic_id", clinic_id) \
        .eq("is_active", True) \
        .order("starts_at", desc=True) \
        .limit(1) \
        .execute()

    if not res.data:
        return False, False, None

    lic = res.data[0]
    plan = lic.get("plan")

    # Lifetime — never expires
    if plan == "lifetime" or lic.get("expires_at") is None:
        return True, False, None

    expires = date.fromisoformat(lic["expires_at"])
    today = date.today()
    delta = (expires - today).days

    if delta >= 0:
        return True, False, delta          # valid
    elif delta >= -5:
        return False, True, delta          # expired but in grace
    else:
        return False, False, delta         # fully expired, blocked

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
def _auth(roles=None, setting=None):
    """
    Decorator that:
    1. Validates session exists and is not expired
    2. Checks license (blocks if expired past grace)
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

            # Super admin bypasses license and permission checks
            if role == "super_admin":
                return f(*args, **kwargs)

            # 2. License check
            valid, in_grace, days_left = _check_license(clinic_id)
            if not valid and not in_grace:
                return err("License expired", 403)

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
def login():
    body = request.get_json() or {}
    username = (body.get("username") or "").strip()
    password = body.get("password") or ""

    if not username or not password:
        return err("Username and password are required")

    # Fetch user
    res = db.table("users") \
        .select("*") \
        .eq("username", username) \
        .eq("is_active", True) \
        .limit(1) \
        .execute()

    if not res.data:
        return err("Invalid credentials", 401)

    user = res.data[0]

    # Verify password
    if not bcrypt.checkpw(password.encode(), user["password_hash"].encode()):
        return err("Invalid credentials", 401)

    role = user["role"]
    clinic_id = user["clinic_id"]

    # License check (skip for super_admin)
    grace_warning = None
    if role != "super_admin":
        valid, in_grace, days_left = _check_license(clinic_id)
        if not valid and not in_grace:
            return err("License expired. Please contact support.", 403)
        if in_grace:
            grace_warning = f"License expired. {abs(days_left)} grace day(s) remaining."

    # Build session
    session.permanent = True
    session["user_id"]   = user["id"]
    session["clinic_id"] = clinic_id
    session["role"]      = role
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat()

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
    })


@app.route("/api/logout", methods=["POST"])
def logout():
    session.clear()
    return ok()


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
    if role != "super_admin":
        valid, in_grace, days_left = _check_license(clinic_id)
        if not valid and not in_grace:
            session.clear()
            return err("License expired", 403)
        if in_grace:
            grace_warning = f"Grace period: {abs(days_left)} day(s) remaining."

    # Refresh session expiry
    session["expires_at"] = (datetime.utcnow() + timedelta(hours=8)).isoformat()

    return ok({
        "user_id":       session["user_id"],
        "clinic_id":     clinic_id,
        "role":          role,
        "grace_warning": grace_warning,
    })


@app.route("/api/change-password", methods=["POST"])
@_auth()
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

    return ok()


# ─────────────────────────────────────────────────────────────
# DASHBOARD
# ─────────────────────────────────────────────────────────────

@app.route("/api/dashboard/stats", methods=["GET"])
@_auth()
def dashboard_stats():
    cid = session["clinic_id"]
    today = today_str()
    month_start = date.today().replace(day=1).isoformat()

    # Today's visits
    today_v = db.table("visits").select("amount_paid,remaining") \
        .eq("clinic_id", cid).eq("visit_date", today).execute()
    today_visits = today_v.data or []
    today_patients = len(today_visits)
    today_earnings = sum(v.get("amount_paid", 0) or 0 for v in today_visits)

    # Total outstanding debt
    debt_r = db.table("visits").select("remaining") \
        .eq("clinic_id", cid).execute()
    outstanding = sum(v.get("remaining", 0) or 0 for v in (debt_r.data or []))

    # Monthly revenue
    month_v = db.table("visits").select("amount_paid") \
        .eq("clinic_id", cid).gte("visit_date", month_start).execute()
    monthly_revenue = sum(v.get("amount_paid", 0) or 0 for v in (month_v.data or []))

    # Low stock count — always use client-side fallback (no RPC dependency)
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
    seven_ago = (date.today() - timedelta(days=6)).isoformat()
    week_v = db.table("visits").select("visit_date,amount_paid") \
        .eq("clinic_id", cid).gte("visit_date", seven_ago).execute()

    chart = {}
    for i in range(7):
        d = (date.today() - timedelta(days=6-i)).isoformat()
        chart[d] = 0
    for v in (week_v.data or []):
        d = v.get("visit_date")
        if d in chart:
            chart[d] += v.get("amount_paid", 0) or 0

    # Recent 5 visits
    recent_v = db.table("visits").select(
        "id,visit_date,total_amount,amount_paid,remaining,patient_id,lens_type"
    ).eq("clinic_id", cid).order("visit_date", desc=True).limit(5).execute()

    return ok({
        "today_patients":   today_patients,
        "today_earnings":   today_earnings,
        "outstanding_debt": outstanding,
        "low_stock_count":  low_count,
        "monthly_revenue":  monthly_revenue,
        "chart_7days":      chart,
        "recent_visits":    recent_v.data or [],
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
@_auth(roles=["doctor"], setting="recept_edit_patients")
def create_patient():
    cid  = session["clinic_id"]
    uid  = session["user_id"]
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

@app.route("/api/reports/summary", methods=["GET"])
@_auth(setting="recept_export_reports")
def reports_summary():
    cid       = session["clinic_id"]
    date_from = request.args.get("from", date.today().replace(day=1).isoformat())
    date_to   = request.args.get("to",   today_str())

    visits = db.table("visits").select(
        "id,patient_id,visit_date,total_amount,amount_paid,remaining,lens_type,created_at"
    ).eq("clinic_id", cid).gte("visit_date", date_from).lte("visit_date", date_to) \
     .order("visit_date", desc=True).execute()

    rows = visits.data or []

    revenue     = sum(r.get("amount_paid",  0) or 0 for r in rows)
    outstanding = sum(r.get("remaining",    0) or 0 for r in rows)
    patient_ids = list({r["patient_id"] for r in rows})

    # New patients in range
    new_ps = db.table("patients").select("id").eq("clinic_id", cid) \
        .gte("created_at", date_from + "T00:00:00") \
        .lte("created_at", date_to   + "T23:59:59").execute()

    return ok({
        "total_revenue":     revenue,
        "total_outstanding": outstanding,
        "patients_seen":     len(rows),
        "unique_patients":   len(patient_ids),
        "new_patients":      len(new_ps.data or []),
        "visits":            rows,
    })


@app.route("/api/reports/export/excel", methods=["GET"])
@_auth(setting="recept_export_reports")
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
@_auth(setting="recept_export_reports")
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
    cl  = db.table("clinics").select("id,name,logo_url,phone,address").eq("id", cid).single().execute()
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

    return ok(clinic_list)


@app.route("/api/admin/clinics", methods=["POST"])
@_auth()
@_require_super
def admin_create_clinic():
    body = request.get_json() or {}
    name      = (body.get("name") or "").strip()
    username  = (body.get("doctor_username") or "").strip()
    password  = body.get("doctor_password") or ""
    plan      = body.get("plan", "trial")
    full_name = body.get("doctor_full_name") or name + " Doctor"

    if not name or not username or not password:
        return err("name, doctor_username, doctor_password are required")

    # Create clinic
    clinic_res = db.table("clinics").insert({
        "name":       name,
        "phone":      body.get("phone"),
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
    allowed = ["name","phone","address","logo_url"]
    updates = {k: v for k, v in body.items() if k in allowed}
    if updates:
        db.table("clinics").update(updates).eq("id", cid).execute()
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
    return err("Internal server error", 500)


# ─────────────────────────────────────────────────────────────
# ENTRY POINT (local dev only — Vercel uses WSGI)
# ─────────────────────────────────────────────────────────────
if __name__ == "__main__":
    app.run(debug=True, port=5000)
