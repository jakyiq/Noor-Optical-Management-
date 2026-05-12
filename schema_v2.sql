-- ============================================================
-- Noor Optical Clinic SaaS — schema_v2_fixed.sql
-- Run this ONCE in Supabase SQL Editor
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ─────────────────────────────────────────────
-- ENUMS  (must come before any table that uses them)
-- ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE license_plan AS ENUM ('trial','monthly','quarterly','yearly','lifetime','custom');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('super_admin','doctor','receptionist');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gender_type AS ENUM ('male','female');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE audit_action AS ENUM ('create','update','delete','login','logout');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lens_type_enum AS ENUM (
    'single_vision','bifocal','progressive','reading','plano'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lens_material_enum AS ENUM ('plastic','glass','contact');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE lens_coating_enum AS ENUM (
    'clear','blue_cut','green_cut','photochromic','photo_blue',
    'photo_green','polarized','anti_reflective','tinted','uv400'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE frame_type_enum AS ENUM ('full_rim','half_rim','rimless');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─────────────────────────────────────────────
-- CLINICS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS clinics (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  logo_url    TEXT,
  phone       TEXT,
  owner_email TEXT,
  owner_auth_user_id UUID,
  is_banned   BOOLEAN NOT NULL DEFAULT FALSE,
  banned_at   TIMESTAMPTZ,
  banned_reason TEXT,
  address     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────
-- MIGRATION GUARDS: ADD COLUMN IF NOT EXISTS
-- These are intentional no-ops on a fresh DB but safely add columns to
-- existing databases that were created before these columns were introduced.
-- NOTE: ADD COLUMN IF NOT EXISTS is silently skipped when a column already
-- exists, regardless of type/default changes. If you change a column type,
-- use a separate ALTER TABLE ... ALTER COLUMN statement.
-- ─────────────────────────────────────────────
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS owner_email TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS owner_auth_user_id UUID;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS is_banned BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS banned_reason TEXT;
ALTER TABLE clinics ADD COLUMN IF NOT EXISTS address TEXT;

-- ─────────────────────────────────────────────
-- LICENSES
-- ─────────────────────────────────────────────
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
CREATE TABLE IF NOT EXISTS users (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id            UUID REFERENCES clinics(id) ON DELETE CASCADE, -- NULL for super_admin
  username             TEXT NOT NULL UNIQUE,
  email                TEXT,
  auth_user_id          UUID,
  password_hash        TEXT NOT NULL,
  role                 user_role NOT NULL DEFAULT 'receptionist',
  full_name            TEXT NOT NULL,
  is_active            BOOLEAN NOT NULL DEFAULT TRUE,
  must_change_password BOOLEAN NOT NULL DEFAULT TRUE,
  last_login           TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_user_id UUID;

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
  wa_pdf_send_message      BOOLEAN NOT NULL DEFAULT TRUE,
  wa_pdf_message           TEXT,
  -- Print defaults
  print_header_text        TEXT,
  print_certification_text TEXT,
  print_warning_text       TEXT,
  print_qr_url             TEXT,
  print_show_financials    BOOLEAN NOT NULL DEFAULT TRUE,
  print_doctor_name        TEXT,
  print_doctor_credentials TEXT,
  print_logo_align         TEXT NOT NULL DEFAULT 'center',
  print_logo_width         INTEGER NOT NULL DEFAULT 120,
  print_logo_height        INTEGER NOT NULL DEFAULT 60,
  print_logo_data          TEXT,
  print_qr_data            TEXT,
  print_associates         TEXT,
  default_checkup_fee      NUMERIC(12,0) NOT NULL DEFAULT 0,
  -- UI preference
  language                 TEXT NOT NULL DEFAULT 'ar'
);

ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_header_text TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_certification_text TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_warning_text TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_qr_url TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_show_financials BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS default_checkup_fee NUMERIC(12,0) NOT NULL DEFAULT 0;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_doctor_name TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_doctor_credentials TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_logo_align TEXT NOT NULL DEFAULT 'center';
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_logo_width INTEGER NOT NULL DEFAULT 120;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_logo_height INTEGER NOT NULL DEFAULT 60;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_logo_data TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_qr_data TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS print_associates TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS wa_pdf_send_message BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS wa_pdf_message TEXT;
ALTER TABLE clinic_settings ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'ar';

-- ─────────────────────────────────────────────
-- PATIENTS
-- ─────────────────────────────────────────────
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

CREATE INDEX IF NOT EXISTS idx_patients_clinic ON patients(clinic_id);
CREATE INDEX IF NOT EXISTS idx_patients_name   ON patients(clinic_id, full_name);
CREATE INDEX IF NOT EXISTS idx_patients_phone  ON patients(clinic_id, phone);

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

ALTER TABLE frames ALTER COLUMN frame_type TYPE TEXT USING frame_type::TEXT;

CREATE TABLE IF NOT EXISTS clinic_lens_catalog (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN ('type','material','coating')),
  value       TEXT NOT NULL,
  label       TEXT NOT NULL,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (clinic_id, category, value)
);

CREATE INDEX IF NOT EXISTS idx_clinic_lens_catalog_clinic ON clinic_lens_catalog(clinic_id, category, sort_order);

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

CREATE INDEX IF NOT EXISTS idx_lenses_clinic ON lenses(clinic_id);
CREATE INDEX IF NOT EXISTS idx_lenses_power  ON lenses(clinic_id, sphere, cylinder);

ALTER TABLE lenses ALTER COLUMN coating DROP DEFAULT;
ALTER TABLE lenses ALTER COLUMN lens_type TYPE TEXT USING lens_type::TEXT;
ALTER TABLE lenses ALTER COLUMN material  TYPE TEXT USING material::TEXT;
ALTER TABLE lenses ALTER COLUMN coating   TYPE TEXT USING coating::TEXT;
ALTER TABLE lenses ALTER COLUMN coating SET DEFAULT 'clear';

-- ─────────────────────────────────────────────
-- VISITS (prescriptions)
-- ─────────────────────────────────────────────
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
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()   -- required for local-first conflict detection
);

CREATE INDEX IF NOT EXISTS idx_visits_clinic  ON visits(clinic_id);
CREATE INDEX IF NOT EXISTS idx_visits_patient ON visits(clinic_id, patient_id);
CREATE INDEX IF NOT EXISTS idx_visits_date    ON visits(clinic_id, visit_date);
CREATE INDEX IF NOT EXISTS idx_visits_next    ON visits(clinic_id, next_visit_date);

ALTER TABLE visits ALTER COLUMN lens_type     TYPE TEXT USING lens_type::TEXT;
ALTER TABLE visits ALTER COLUMN lens_material TYPE TEXT USING lens_material::TEXT;
ALTER TABLE visits ALTER COLUMN frame_type    TYPE TEXT USING frame_type::TEXT;
ALTER TABLE visits ADD COLUMN IF NOT EXISTS lens_id UUID REFERENCES lenses(id) ON DELETE SET NULL;

-- ─────────────────────────────────────────────
-- RETAIL / MISCELLANEOUS SALES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS retail_sales (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  item_name      TEXT NOT NULL,
  item_type      TEXT NOT NULL DEFAULT 'misc',
  quantity       INTEGER NOT NULL DEFAULT 1,
  cost_price     NUMERIC(12,0) NOT NULL DEFAULT 0,
  selling_price  NUMERIC(12,0) NOT NULL DEFAULT 0,
  sale_date      DATE NOT NULL DEFAULT CURRENT_DATE,
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retail_sales_clinic ON retail_sales(clinic_id);
CREATE INDEX IF NOT EXISTS idx_retail_sales_date   ON retail_sales(clinic_id, sale_date);

-- ─────────────────────────────────────────────
-- OPERATIONAL EXPENSES
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS operating_expenses (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  expense_type   TEXT NOT NULL DEFAULT 'misc',
  frequency      TEXT NOT NULL DEFAULT 'monthly',
  amount         NUMERIC(12,0) NOT NULL DEFAULT 0,
  starts_on      DATE NOT NULL DEFAULT CURRENT_DATE,
  is_active      BOOLEAN NOT NULL DEFAULT TRUE,
  notes          TEXT,
  created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operating_expenses_clinic ON operating_expenses(clinic_id);
CREATE INDEX IF NOT EXISTS idx_operating_expenses_start  ON operating_expenses(clinic_id, starts_on);

-- ─────────────────────────────────────────────
-- AUDIT LOG
-- ─────────────────────────────────────────────
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
-- BACKUPS
-- ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS backup_log (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id    UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
  created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
  kind         TEXT NOT NULL DEFAULT 'manual',
  row_counts   JSONB,
  backup_data  JSONB,        -- inline backup payload (small / legacy)
  storage_path TEXT,         -- path in object storage (large backups via upload)
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_backup_log_clinic ON backup_log(clinic_id, created_at DESC);

-- ─────────────────────────────────────────────
-- SUPER ADMIN USER
-- Create the first super admin manually with a unique password for each environment.
-- Do not ship default admin credentials in production schema.
-- ─────────────────────────────────────────────
-- ─────────────────────────────────────────────
-- ROW LEVEL SECURITY
-- Flask uses the Supabase service role and remains the trusted API.
-- Direct anon/client access is denied unless a policy below allows it.
-- Sensitive backend-only tables intentionally have no client policies:
-- licenses, clinic_settings, audit_log.
-- If a future frontend Supabase client is added, issue JWTs with:
--   clinic_id: <clinic uuid>
--   role: doctor | receptionist | super_admin
-- ─────────────────────────────────────────────
ALTER TABLE clinics         ENABLE ROW LEVEL SECURITY;
ALTER TABLE licenses        ENABLE ROW LEVEL SECURITY;
ALTER TABLE users           ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE patients        ENABLE ROW LEVEL SECURITY;
ALTER TABLE visits          ENABLE ROW LEVEL SECURITY;
ALTER TABLE lenses          ENABLE ROW LEVEL SECURITY;
ALTER TABLE clinic_lens_catalog ENABLE ROW LEVEL SECURITY;
ALTER TABLE frames          ENABLE ROW LEVEL SECURITY;
ALTER TABLE retail_sales    ENABLE ROW LEVEL SECURITY;
ALTER TABLE operating_expenses ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log       ENABLE ROW LEVEL SECURITY;
ALTER TABLE backup_log      ENABLE ROW LEVEL SECURITY;

-- ─────────────────────────────────────────────
-- JWT HELPER FUNCTIONS
-- ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION jwt_clinic_id()
RETURNS UUID
LANGUAGE sql
STABLE
AS $$
  SELECT NULLIF(auth.jwt() ->> 'clinic_id', '')::UUID;
$$;

CREATE OR REPLACE FUNCTION jwt_app_role()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(auth.jwt() ->> 'role', '');
$$;

-- ─────────────────────────────────────────────
-- CLINICS
-- Each clinic can only see its own row; super_admin sees all.
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS clinics_same_clinic_select ON clinics;
CREATE POLICY clinics_same_clinic_select ON clinics
  FOR SELECT TO authenticated
  USING (id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- USERS
-- Clinic staff can see users in their own clinic.
-- super_admin sees all users.
-- No client-side insert/update/delete — managed exclusively via Flask.
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS users_same_clinic_select ON users;
CREATE POLICY users_same_clinic_select ON users
  FOR SELECT TO authenticated
  USING (
    clinic_id = jwt_clinic_id()
    OR jwt_app_role() = 'super_admin'
    -- Allow users to always see their own row
    OR auth.uid() = auth_user_id
  );

-- Prevent any direct client writes to users — Flask API only
DROP POLICY IF EXISTS users_no_direct_insert ON users;
DROP POLICY IF EXISTS users_no_direct_update ON users;
DROP POLICY IF EXISTS users_no_direct_delete ON users;
-- (No INSERT/UPDATE/DELETE policies = denied for all authenticated/anon roles)

-- ─────────────────────────────────────────────
-- CLINIC_SETTINGS
-- Only the owning clinic (doctor role or super_admin) may read.
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS clinic_settings_same_clinic_select ON clinic_settings;
CREATE POLICY clinic_settings_same_clinic_select ON clinic_settings
  FOR SELECT TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- PATIENTS
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS patients_same_clinic_select ON patients;
CREATE POLICY patients_same_clinic_select ON patients
  FOR SELECT TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS patients_same_clinic_insert ON patients;
CREATE POLICY patients_same_clinic_insert ON patients
  FOR INSERT TO authenticated
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS patients_same_clinic_update ON patients;
CREATE POLICY patients_same_clinic_update ON patients
  FOR UPDATE TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS patients_same_clinic_delete ON patients;
CREATE POLICY patients_same_clinic_delete ON patients
  FOR DELETE TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- VISITS
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS visits_same_clinic_select ON visits;
CREATE POLICY visits_same_clinic_select ON visits
  FOR SELECT TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS visits_same_clinic_insert ON visits;
CREATE POLICY visits_same_clinic_insert ON visits
  FOR INSERT TO authenticated
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS visits_same_clinic_update ON visits;
CREATE POLICY visits_same_clinic_update ON visits
  FOR UPDATE TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS visits_same_clinic_delete ON visits;
CREATE POLICY visits_same_clinic_delete ON visits
  FOR DELETE TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- LENSES, FRAMES, RETAIL SALES, OPERATING EXPENSES
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS lenses_same_clinic_all ON lenses;
CREATE POLICY lenses_same_clinic_all ON lenses
  FOR ALL TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS clinic_lens_catalog_same_clinic_all ON clinic_lens_catalog;
CREATE POLICY clinic_lens_catalog_same_clinic_all ON clinic_lens_catalog
  FOR ALL TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS frames_same_clinic_all ON frames;
CREATE POLICY frames_same_clinic_all ON frames
  FOR ALL TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS retail_sales_same_clinic_all ON retail_sales;
CREATE POLICY retail_sales_same_clinic_all ON retail_sales
  FOR ALL TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

DROP POLICY IF EXISTS operating_expenses_same_clinic_all ON operating_expenses;
CREATE POLICY operating_expenses_same_clinic_all ON operating_expenses
  FOR ALL TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin')
  WITH CHECK (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- AUDIT LOG — read-only for clinic staff; super_admin sees all
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS audit_log_same_clinic_select ON audit_log;
CREATE POLICY audit_log_same_clinic_select ON audit_log
  FOR SELECT TO authenticated
  USING (clinic_id = jwt_clinic_id() OR jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- LICENSES — super_admin only via RLS; clinic reads go through Flask
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS licenses_super_admin_all ON licenses;
CREATE POLICY licenses_super_admin_all ON licenses
  FOR ALL TO authenticated
  USING (jwt_app_role() = 'super_admin')
  WITH CHECK (jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- BACKUP LOG — super_admin only
-- ─────────────────────────────────────────────
DROP POLICY IF EXISTS backup_log_super_admin_select ON backup_log;
CREATE POLICY backup_log_super_admin_select ON backup_log
  FOR SELECT TO authenticated
  USING (jwt_app_role() = 'super_admin');

-- ─────────────────────────────────────────────
-- ANON BLOCK: deny all anon access explicitly
-- ─────────────────────────────────────────────
DO $$
DECLARE
  t TEXT;
  tbls TEXT[] := ARRAY[
    'clinics','licenses','users','clinic_settings','patients','visits',
    'lenses','frames','retail_sales','operating_expenses','audit_log','backup_log'
  ];
BEGIN
  FOREACH t IN ARRAY tbls LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS %I ON %I',
      t || '_deny_anon', t
    );
    EXECUTE format(
      'CREATE POLICY %I ON %I FOR ALL TO anon USING (false)',
      t || '_deny_anon', t
    );
  END LOOP;
END $$;

-- ─────────────────────────────────────────────
-- HELPER FUNCTIONS
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
