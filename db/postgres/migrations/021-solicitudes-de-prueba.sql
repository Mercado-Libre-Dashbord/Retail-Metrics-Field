-- Solicitudes de prueba gratis que llegan desde la landing pública de
-- Retail. Correr tal cual en el SQL Editor de Supabase. Idempotente.
--
-- Cualquiera puede dejar una solicitud (el formulario es público), pero
-- solo un admin las puede ver, cambiar de estado o borrar: RLS deja INSERT
-- sin condición y todo lo demás detrás de app_is_admin(). Las columnas utm_*
-- guardan de qué campaña y variante de mail vino cada solicitud, para medir
-- la prospección hasta el cliente pago.

CREATE TABLE IF NOT EXISTS trial_requests (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  store TEXT NOT NULL,
  monthly_sales TEXT,
  phone TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  utm_content TEXT,
  referrer TEXT,
  status TEXT NOT NULL DEFAULT 'nueva'
);
-- Una solicitud por email: si la vuelve a mandar, no se duplica.
CREATE UNIQUE INDEX IF NOT EXISTS idx_trial_requests_email ON trial_requests (lower(email));

ALTER TABLE trial_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE trial_requests FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS trial_requests_insert ON trial_requests;
CREATE POLICY trial_requests_insert ON trial_requests FOR INSERT WITH CHECK (true);
DROP POLICY IF EXISTS trial_requests_select ON trial_requests;
CREATE POLICY trial_requests_select ON trial_requests FOR SELECT USING (app_is_admin());
DROP POLICY IF EXISTS trial_requests_update ON trial_requests;
CREATE POLICY trial_requests_update ON trial_requests FOR UPDATE USING (app_is_admin()) WITH CHECK (app_is_admin());
DROP POLICY IF EXISTS trial_requests_delete ON trial_requests;
CREATE POLICY trial_requests_delete ON trial_requests FOR DELETE USING (app_is_admin());

GRANT SELECT, INSERT, UPDATE, DELETE ON trial_requests TO app_user;
GRANT USAGE, SELECT ON SEQUENCE trial_requests_id_seq TO app_user;

-- Verificación: 1 fila, con rowsecurity y forcerowsecurity en true.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relname = 'trial_requests';
