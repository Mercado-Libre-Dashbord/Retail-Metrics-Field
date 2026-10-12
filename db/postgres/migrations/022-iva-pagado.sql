-- IVA que el vendedor pagó realmente, mes por mes (el saldo de la DDJJ que
-- le pasa su contador). Correr tal cual en el SQL Editor de Supabase.
-- Idempotente.
--
-- Con ese monto la app calcula el % de IVA efectivo del mes (IVA pagado ÷
-- facturación del mes) y lo reparte entre las ventas de ese mes en lugar
-- del cálculo teórico al 21% (débito − crédito). Los meses sin monto usan el
-- % del último mes cargado. Una cuenta sin ningún monto cargado sigue
-- exactamente como antes.

CREATE TABLE IF NOT EXISTS iva_payments (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  period DATE NOT NULL,
  amount DOUBLE PRECISION NOT NULL CHECK (amount >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, period)
);

ALTER TABLE iva_payments ENABLE ROW LEVEL SECURITY;
ALTER TABLE iva_payments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS iva_payments_isolation ON iva_payments;
CREATE POLICY iva_payments_isolation ON iva_payments
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON iva_payments TO app_user;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON iva_payments FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Verificación: 1 fila, con rowsecurity y forcerowsecurity en true.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relname = 'iva_payments';
