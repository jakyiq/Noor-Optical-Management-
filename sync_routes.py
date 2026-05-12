"""
sync_routes.py — Local-First sync endpoint for Noor Optical Clinic
──────────────────────────────────────────────────────────────────────────────
Add this file to your project and register it in app.py with:

    from sync_routes import sync_bp
    app.register_blueprint(sync_bp)

The frontend (localFirst.js) calls POST /api/sync/item for every pending
queue item.  This route:
  1. Validates the session and CSRF token (handled by the global @before_request).
  2. Fetches the current server record (if any) and compares timestamps.
  3. If the server record is NEWER → returns HTTP 409 with the server record
     so the client can prompt the user.
  4. If local is newer (or record is new) → upserts into Supabase and returns
     the updated row.
──────────────────────────────────────────────────────────────────────────────
"""

from flask import Blueprint, request, jsonify, session
from datetime import datetime
import logging

# These helpers are already defined in app.py.
# When registered as a blueprint they inherit the app context,
# so `db` (the Supabase client) is imported directly.
from app import db, ok, err, now_iso, _write_audit, _auth

sync_bp = Blueprint('sync', __name__, url_prefix='/api/sync')

# Tables the client is allowed to push via the sync endpoint.
# Add or remove tables as your schema evolves.
SYNCABLE_TABLES = {
    'patients':           'clinic_id',
    'visits':             'clinic_id',
    'frames':             'clinic_id',
    'lenses':             'clinic_id',
    'retail_sales':       'clinic_id',
    'operating_expenses': 'clinic_id',
    'clinic_settings':    'clinic_id',
    'clinic_lens_catalog':'clinic_id',
}


def _parse_ts(ts_str):
    """Return a UTC datetime from an ISO-8601 string, or None."""
    if not ts_str:
        return None
    try:
        # Handle both 'Z' suffix and '+00:00' offset
        return datetime.fromisoformat(ts_str.replace('Z', '+00:00'))
    except ValueError:
        return None


@sync_bp.route('/item', methods=['POST'])
@_auth()
def sync_item():
    """
    Accept a single pending queue item from the client and upsert it into
    Supabase, with timestamp-based conflict detection.

    Request body (JSON):
    {
        "local_id":     <int>,        # client-side IDB key (for logging only)
        "entity_type":  "patients",   # which Supabase table
        "entity_id":    "<uuid>",     # row id, null for new records
        "operation":    "upsert",     # "upsert" | "delete"
        "payload":      { ... },      # full record body
        "last_modified": "<iso8601>", # client timestamp
        "force":        false         # true = skip conflict check
    }

    Responses:
        200  { ok: true, data: <server_row> }           — synced successfully
        409  { conflict: true, server_record: <row> }   — server is newer
        400  { error: "..." }                            — bad request
        403  { error: "..." }                            — auth / ownership error
    """
    body         = request.get_json(force=True) or {}
    clinic_id    = session.get('clinic_id')
    user_id      = session.get('user_id')
    entity_type  = body.get('entity_type', '').strip()
    entity_id    = body.get('entity_id')        # may be None for new records
    operation    = body.get('operation', 'upsert').strip()
    payload      = body.get('payload') or {}
    local_ts_str = body.get('last_modified')
    force        = bool(body.get('force', False))

    # ── Validate entity type ──────────────────────────────────────────────────
    if entity_type not in SYNCABLE_TABLES:
        return err(f"Entity type '{entity_type}' is not syncable.", 400)

    if operation not in ('upsert', 'delete'):
        return err(f"Unknown operation '{operation}'.", 400)

    # ── Ensure the payload belongs to this clinic (security) ─────────────────
    clinic_field = SYNCABLE_TABLES[entity_type]
    if payload.get(clinic_field) and payload[clinic_field] != clinic_id:
        return err('Payload clinic_id does not match session.', 403)

    # Always stamp the clinic_id from the session — never trust the client.
    payload[clinic_field] = clinic_id

    # ── Handle DELETE ─────────────────────────────────────────────────────────
    if operation == 'delete':
        if not entity_id:
            return err('entity_id is required for delete.', 400)
        try:
            _verify_ownership(entity_type, entity_id, clinic_id)
        except PermissionError as exc:
            return err(str(exc), 403)
        db.table(entity_type).delete().eq('id', entity_id).execute()
        _write_audit(clinic_id, user_id, 'delete', entity_type, entity_id)
        return ok({'deleted': True, 'entity_id': entity_id})

    # ── UPSERT path ───────────────────────────────────────────────────────────
    local_ts = _parse_ts(local_ts_str)

    # Fetch current server record (if it exists)
    server_row = None
    if entity_id:
        res = (
            db.table(entity_type)
            .select('*')
            .eq('id', entity_id)
            .eq(clinic_field, clinic_id)
            .limit(1)
            .execute()
        )
        server_row = res.data[0] if res.data else None

    # ── Conflict detection ────────────────────────────────────────────────────
    if server_row and not force:
        # Prefer updated_at, fall back to created_at
        server_ts_str = server_row.get('updated_at') or server_row.get('created_at')
        server_ts     = _parse_ts(server_ts_str)

        if server_ts and local_ts and server_ts > local_ts:
            logging.info(
                '[sync] Conflict on %s %s: server=%s > local=%s',
                entity_type, entity_id, server_ts_str, local_ts_str,
            )
            return jsonify({'conflict': True, 'server_record': server_row}), 409

    # ── Apply the upsert ──────────────────────────────────────────────────────
    # Stamp server-side timestamps — never use whatever the client sent for
    # updated_at, to maintain a trusted audit trail.
    payload['updated_at'] = now_iso()
    if not server_row:
        payload.setdefault('created_at', now_iso())

    old_value = server_row  # for audit log

    if server_row:
        result = (
            db.table(entity_type)
            .update(payload)
            .eq('id', entity_id)
            .eq(clinic_field, clinic_id)
            .execute()
        )
    else:
        result = db.table(entity_type).insert(payload).execute()

    new_row = result.data[0] if result.data else payload

    _write_audit(
        clinic_id, user_id,
        action       = 'update' if server_row else 'create',
        entity_type  = entity_type,
        entity_id    = new_row.get('id') or entity_id,
        old_value    = old_value,
        new_value    = new_row,
    )

    return ok(new_row)


# ── Bulk status endpoint (optional — for a debug/admin panel) ─────────────────
@sync_bp.route('/status', methods=['GET'])
@_auth()
def sync_status():
    """
    Returns per-table row counts for the clinic.
    Handy for showing a "last synced" panel in the UI.
    """
    clinic_id = session.get('clinic_id')
    counts    = {}
    for table, clinic_field in SYNCABLE_TABLES.items():
        res = (
            db.table(table)
            .select('id', count='exact')
            .eq(clinic_field, clinic_id)
            .execute()
        )
        counts[table] = res.count
    return ok({'counts': counts, 'as_of': now_iso()})


# ── Private helpers ───────────────────────────────────────────────────────────

def _verify_ownership(entity_type, entity_id, clinic_id):
    """
    Raise PermissionError if the requested row doesn't belong to this clinic.
    Guards against cross-clinic deletes.
    """
    clinic_field = SYNCABLE_TABLES.get(entity_type, 'clinic_id')
    res = (
        db.table(entity_type)
        .select(clinic_field)
        .eq('id', entity_id)
        .limit(1)
        .execute()
    )
    row = res.data[0] if res.data else None
    if row and row.get(clinic_field) != clinic_id:
        raise PermissionError(f'{entity_type} {entity_id} does not belong to clinic {clinic_id}')
