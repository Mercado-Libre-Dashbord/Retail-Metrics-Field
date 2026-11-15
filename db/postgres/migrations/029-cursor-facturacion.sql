-- 029 · Dónde quedó la descarga de la factura de Mercado Libre. Correr tal cual
-- en el SQL Editor de Supabase. Idempotente.
--
-- Hasta ahora, para seguir una factura grande entre sincronizaciones se
-- retomaba desde el detail_id más alto guardado. Mercado Libre agrega a un
-- documento filas con ids MENORES a ese (verificado: una nota de crédito
-- tenía 281 filas y solo se habían guardado 181), y esas nunca se volvían a
-- pedir. Ahora se guarda el cursor que devuelve Mercado Libre, y cuando el
-- total de filas del documento cambia se lo vuelve a recorrer desde el
-- principio.
--
-- doc_key: la clave del documento ("2026-11-01" para la factura del período).
-- from_id: por dónde seguir. total: cuántas filas informaba Mercado Libre.
-- complete: si ya se recorrió entero.

CREATE TABLE IF NOT EXISTS billing_scan_cursors (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  doc_key TEXT NOT NULL,
  from_id TEXT NOT NULL DEFAULT '0',
  total INTEGER,
  complete BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, doc_key)
);

ALTER TABLE billing_scan_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_scan_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS billing_scan_cursors_isolation ON billing_scan_cursors;
CREATE POLICY billing_scan_cursors_isolation ON billing_scan_cursors
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON billing_scan_cursors TO app_user;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON billing_scan_cursors FROM %I', r);
    END IF;
  END LOOP;
END $$;

-- Verificación: 1 fila.
SELECT table_name FROM information_schema.tables WHERE table_name = 'billing_scan_cursors';
