-- 027 · Seguimiento de la competencia en publicaciones de catálogo. Correr tal
-- cual en el SQL Editor de Supabase. Idempotente.
--
-- competition_snapshots: cada vez que se consulta el "precio para ganar" de
--   una publicación, una fila (estado, quién gana, a qué precio, por qué).
--   Las publicaciones que no son de catálogo quedan con status 'not_catalog'
--   para no volver a preguntarle a Mercado Libre en cada actualización.
-- competitor_prices: el precio de cada publicación de la competencia en ese
--   catálogo. Solo se agrega una fila cuando el precio cambió, así la tabla
--   es directamente el historial de cambios de precio de los demás.
-- account_id_for_seller(): el webhook de Mercado Libre llega sin sesión y
--   trae el user_id del vendedor; esta función devuelve SOLO el id de cuenta
--   que le corresponde, para poder procesar la notificación de esa cuenta.

CREATE TABLE IF NOT EXISTS competition_snapshots (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  product_id TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  catalog_product_id TEXT,
  status TEXT NOT NULL,
  my_price DOUBLE PRECISION,
  price_to_win DOUBLE PRECISION,
  winner_item_id TEXT,
  winner_price DOUBLE PRECISION,
  visit_share TEXT,
  reasons TEXT[] NOT NULL DEFAULT '{}',
  boosts JSONB NOT NULL DEFAULT '[]'::jsonb
);
CREATE INDEX IF NOT EXISTS competition_snapshots_latest
  ON competition_snapshots (account_id, product_id, captured_at DESC);

CREATE TABLE IF NOT EXISTS competitor_prices (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  catalog_product_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  seller_id TEXT,
  seller_nickname TEXT,
  price DOUBLE PRECISION NOT NULL,
  free_shipping BOOLEAN,
  listing_type TEXT,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS competitor_prices_item
  ON competitor_prices (account_id, item_id, captured_at DESC);
CREATE INDEX IF NOT EXISTS competitor_prices_catalog
  ON competitor_prices (account_id, catalog_product_id, captured_at DESC);

ALTER TABLE competition_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE competition_snapshots FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS competition_snapshots_isolation ON competition_snapshots;
CREATE POLICY competition_snapshots_isolation ON competition_snapshots
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

ALTER TABLE competitor_prices ENABLE ROW LEVEL SECURITY;
ALTER TABLE competitor_prices FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS competitor_prices_isolation ON competitor_prices;
CREATE POLICY competitor_prices_isolation ON competitor_prices
  USING (account_id = app_current_account_id())
  WITH CHECK (account_id = app_current_account_id());

GRANT SELECT, INSERT, DELETE ON competition_snapshots, competitor_prices TO app_user;
GRANT USAGE, SELECT ON SEQUENCE competition_snapshots_id_seq, competitor_prices_id_seq TO app_user;

CREATE OR REPLACE FUNCTION account_id_for_seller(p_seller_id TEXT) RETURNS TEXT AS $$
  SELECT id FROM accounts WHERE ml_seller_id = p_seller_id LIMIT 1;
$$ LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public;
REVOKE EXECUTE ON FUNCTION account_id_for_seller(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION account_id_for_seller(text) TO app_user;

DO $$
DECLARE r TEXT;
BEGIN
  FOREACH r IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('REVOKE ALL ON competition_snapshots, competitor_prices FROM %I', r);
      EXECUTE format('REVOKE EXECUTE ON FUNCTION account_id_for_seller(text) FROM %I', r);
    END IF;
  END LOOP;
END
$$;

-- Verificación: 2 filas, con rowsecurity y forcerowsecurity en true.
SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity
  FROM pg_class c WHERE c.relname IN ('competition_snapshots', 'competitor_prices');
