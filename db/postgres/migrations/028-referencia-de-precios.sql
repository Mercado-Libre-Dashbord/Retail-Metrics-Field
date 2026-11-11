-- 028 · Referencia de precios de Mercado Libre y automatización de precios.
-- Correr tal cual en el SQL Editor de Supabase. Idempotente.
--
-- reference: la "referencia de precios" que da ML para cada publicación (el
--   precio sugerido y el más bajo entre publicaciones similares). A diferencia
--   del precio para ganar, existe también para publicaciones que no son de
--   catálogo.
-- automation: si la publicación tiene activa la automatización de precios de
--   ML (con su mínimo y máximo). Con la automatización activa, ML rechaza los
--   cambios de precio hechos desde otra app.

ALTER TABLE competition_snapshots ADD COLUMN IF NOT EXISTS reference JSONB;
ALTER TABLE competition_snapshots ADD COLUMN IF NOT EXISTS automation JSONB;

-- Verificación: 2 filas.
SELECT column_name FROM information_schema.columns
 WHERE table_name = 'competition_snapshots' AND column_name IN ('reference', 'automation');
