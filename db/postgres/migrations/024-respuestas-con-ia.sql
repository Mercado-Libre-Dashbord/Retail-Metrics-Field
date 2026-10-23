-- 024 · Respuestas a consultas con IA. Correr tal cual en el SQL Editor de
-- Supabase. Idempotente.
--
-- answer_settings: lo que el vendedor quiere que se sepa al responder
-- (envíos, factura, garantía, retiro, horarios...). Se carga una vez en
-- Configuración y se usa junto con la descripción y la ficha de cada
-- publicación de Mercado Libre.
--
-- question_drafts gana de dónde salió el borrador ('rules' | 'ai' | 'manual')
-- y, si lo escribió la IA, si está segura y qué dato le faltó.

CREATE TABLE IF NOT EXISTS answer_settings (
  account_id TEXT PRIMARY KEY REFERENCES accounts(id),
  seller_info TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE answer_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE answer_settings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS answer_settings_isolation ON answer_settings;
CREATE POLICY answer_settings_isolation ON answer_settings
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON answer_settings TO app_user;

ALTER TABLE question_drafts ADD COLUMN IF NOT EXISTS draft_source TEXT NOT NULL DEFAULT 'rules';
ALTER TABLE question_drafts ADD COLUMN IF NOT EXISTS ai_confident BOOLEAN;
ALTER TABLE question_drafts ADD COLUMN IF NOT EXISTS ai_missing TEXT;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON answer_settings FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Verificación: 1 fila, con rowsecurity y forcerowsecurity en true.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relname = 'answer_settings';
