-- ============================================================
-- Noor Optical Clinic SaaS — schema_v2.sql
-- Run this ONCE in Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- CLINICS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  logo_url    TEXT,
  phone       TEXT,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- LICENSES
-- ─────────────────────────────────────────────
CREATE TYPE license_plan AS ENUM ('trial','monthly','quarterly','yearly','lifetime');

CREATE TABLE IF NOT EXISTS licenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  plan        license_plan NOT NULL DEFAULT 'trial',
  starts_at   DATE NOT NULL DEFAULT CURRENT_DATE,
  expires_at  DATE,                        -- NULL = lifetime
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_licenses_clinic ON licenses(clinic_id);

-- ─────────────────────────────────────────────
-- USERS
-- ─────────────────────────────────────────────
CREATE TYPE user_role AS ENUM ('super_admin','doctor','receptionist');

CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            UUID REFERENCES clinics(id) ON DELETE CASCADE, -- NULL for super_admin
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  role                 user_role NOT NULL DEFAULT 'receptionist',
  full_name            TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  last_login           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_clinic    ON users(clinic_id);
CREATE INDEX IF NOT EXISTS idx_users_username  ON users(username);

-- ─────────────────────────────────────────────
-- CLINIC SETTINGS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinic_settings (
  clinic_id                UUID PRIMARY KEY REFERENCES clinics(id) ON DELETE CASCADE,
  -- Receptionist permission toggles
  recept_view_patients     BOOLEAN NOT NULL DEFAULT TRUE,
  recept_edit_patients     BOOLEAN NOT NULL DEFAULT FALSE,
  recept_view_financials   BOOLEAN NOT NULL DEFAULT FALSE,
  recept_edit_financials   BOOLEAN NOT NULL DEFAULT FALSE,
  recept_access_inventory  BOOLEAN NOT NULL DEFAULT FALSE,
  recept_export_reports    BOOLEAN NOT NULL DEFAULT FALSE,
  recept_view_audit        BOOLEAN NOT NULL DEFAULT FALSE,
  -- Follow-up defaults
  followup_months_default  INTEGER NOT NULL DEFAULT 3,
  -- WhatsApp templates
  wa_template_1            TEXT DEFAULT 'عزيزي {patient_name}، يسعدنا تذكيرك بموعدك القادم في {clinic_name} بتاريخ {next_visit}.',
  wa_template_2            TEXT DEFAULT 'مرحباً {patient_name}! حان وقت فحص نظرك الدوري في {clinic_name}.',
  wa_template_3            TEXT DEFAULT '{patient_name}، تذكير بموعد المتابعة {next_visit}. عيادة {clinic_name}.',
  -- UI preference
  language                 TEXT NOT NULL DEFAULT 'ar'
);

-- ─────────────────────────────────────────────
-- PATIENTS
-- ─────────────────────────────────────────────
CREATE TYPE gender_type AS ENUM ('male','female');

CREATE TABLE IF NOT EXISTS patients (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  full_name   TEXT NOT NULL,
  phone       TEXT,
  age         INTEGER,
  gender      gender_type,
  address     TEXT,
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_patients_clinic     ON patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_name       ON patients(clinic_id, full_name);
CREATE INDEX IF NOT EXISTS idx_patients_phone      ON patients(clinic_id, phone);

-- ─────────────────────────────────────────────
-- VISITS (prescriptions)
-- ─────────────────────────────────────────────
CREATE TYPE lens_type_enum AS ENUM (
  'single_vision','bifocal','progressive','reading','plano'
);
CREATE TYPE lens_material_enum AS ENUM ('plastic','glass','contact');
CREATE TYPE lens_coating_enum AS ENUM (
  'clear','blue_cut','green_cut','photochromic','photo_blue',
  'photo_green','polarized','anti_reflective','tinted','uv400'
);
CREATE TYPE frame_type_enum AS ENUM ('full_rim','half_rim','rimless');

CREATE TABLE IF NOT EXISTS visits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  patient_id      UUID NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  -- Rx OD (Right Eye)
  od_sphere       NUMERIC(5,2),
  od_cylinder     NUMERIC(5,2),
  od_axis         INTEGER,
  od_addition     NUMERIC(5,2),
  od_va           TEXT,
  od_bcva         TEXT,
  -- Rx OS (Left Eye)
  os_sphere       NUMERIC(5,2),
  os_cylinder     NUMERIC(5,2),
  os_axis         INTEGER,
  os_addition     NUMERIC(5,2),
  os_va           TEXT,
  os_bcva         TEXT,
  -- Shared
  ipd             NUMERIC(5,1),
  -- Lens config
  lens_type       lens_type_enum,
  lens_material   lens_material_enum,
  lens_coating    TEXT,                    -- comma-separated or single value
  lens_count      INTEGER DEFAULT 2,
  -- Frame
  frame_id        UUID REFERENCES frames(id) ON DELETE SET NULL,
  frame_brand     TEXT,
  frame_type      frame_type_enum,
  frame_material  TEXT,
  -- Checkup
  did_checkup     BOOLEAN NOT NULL DEFAULT FALSE,
  next_visit_date DATE,
  followup_months INTEGER DEFAULT 3,
  -- Financials
  frame_cost      NUMERIC(12,0) DEFAULT 0,
  frame_price     NUMERIC(12,0) DEFAULT 0,
  lens_cost       NUMERIC(12,0) DEFAULT 0,
  lens_price      NUMERIC(12,0) DEFAULT 0,
  checkup_fee     NUMERIC(12,0) DEFAULT 0,
  total_amount    NUMERIC(12,0) DEFAULT 0,
  amount_paid     NUMERIC(12,0) DEFAULT 0,
  remaining       NUMERIC(12,0) DEFAULT 0,
  -- Meta
  visit_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_visits_clinic      ON visits(clinic_id);
CREATE INDEX IF NOT EXISTS idx_visits_patient     ON visits(clinic_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_date        ON visits(clinic_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_next        ON visits(clinic_id, next_visit_date);

-- ─────────────────────────────────────────────
-- LENSES INVENTORY
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lenses (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  lens_type   lens_type_enum,
  material    lens_material_enum,
  coating     lens_coating_enum DEFAULT 'clear',
  sphere      NUMERIC(5,2),
  cylinder    NUMERIC(5,2) DEFAULT 0,
  quantity    INTEGER NOT NULL DEFAULT 0,
  min_stock   INTEGER NOT NULL DEFAULT 2,
  cost_price  NUMERIC(12,0) DEFAULT 0,
  sell_price  NUMERIC(12,0) DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lenses_clinic  ON lenses(clinic_id);
CREATE INDEX IF NOT EXISTS idx_lenses_power   ON lenses(clinic_id, sphere, cylinder);

-- ─────────────────────────────────────────────
-- FRAMES INVENTORY
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS frames (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id       UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  brand           TEXT,
  frame_type      frame_type_enum,
  frame_material  TEXT,
  color           TEXT,
  quantity        INTEGER NOT NULL DEFAULT 0,
  min_stock       INTEGER NOT NULL DEFAULT 2,
  cost_price      NUMERIC(12,0) DEFAULT 0,
  sell_price      NUMERIC(12,0) DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_frames_clinic ON frames(clinic_id);

-- ─────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────
CREATE TYPE audit_action AS ENUM ('create','update','delete','login','logout');

CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID REFERENCES clinics(id) ON DELETE CASCADE,
  user_id     UUID REFERENCES users(id)   ON DELETE SET NULL,
  action      audit_action NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id   UUID,
  old_value   JSONB,
  new_value   JSONB,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_clinic ON audit_log(clinic_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_user   ON audit_log(user_id);

-- ─────────────────────────────────────────────
-- FIX: visits references frames, so frames must
-- exist before the FK. Re-declare FK here safely.
-- ─────────────────────────────────────────────
ALTER TABLE visits
  ADD CONSTRAINT IF NOT EXISTS fk_visits_frame
  FOREIGN KEY (frame_id) REFERENCES frames(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- SUPER ADMIN USER
-- Default login: username=admin  password=admin1234
-- bcrypt hash of "admin1234" with cost 12
-- ─────────────────────────────────────────────
INSERT INTO users (
  clinic_id,
  username,
  password_hash,
  role,
  full_name,
  is_active,
  must_change_password
)
VALUES (
  NULL,
  'admin',
  '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/lewohGEMHLMq7DMYC',
  'super_admin',
  'Super Admin',
  TRUE,
  FALSE
)
ON CONFLICT (username) DO NOTHING;

-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY (optional but recommended)
-- Disable RLS since we use service_role key
-- exclusively in the Flask backend — all clinic
-- isolation is enforced in app.py via clinic_id.
-- ─────────────────────────────────────────────
ALTER TABLE clinics         DISABLE ROW LEVEL SECURITY;
ALTER TABLE licenses        DISABLE ROW LEVEL SECURITY;
ALTER TABLE users           DISABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_settings DISABLE ROW LEVEL SECURITY;
ALTER TABLE patients        DISABLE ROW LEVEL SECURITY;
ALTER TABLE visits          DISABLE ROW LEVEL SECURITY;
ALTER TABLE lenses          DISABLE ROW LEVEL SECURITY;
ALTER TABLE frames          DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log       DISABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────
-- HELPER: count low-stock lenses for a clinic
-- Called by app.py dashboard stats
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION count_low_stock_lenses(p_clinic_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INTEGER
  FROM lenses
  WHERE clinic_id = p_clinic_id
    AND quantity <= min_stock;
$$;

CREATE OR REPLACE FUNCTION count_low_stock_frames(p_clinic_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE AS $$
  SELECT COUNT(*)::INTEGER
  FROM frames
  WHERE clinic_id = p_clinic_id
    AND quantity <= min_stock;
$$;

-- ─────────────────────────────────────────────
-- DONE
-- ─────────────────────────────────────────────
