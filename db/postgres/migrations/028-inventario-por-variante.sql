-- 028 · Stock de Full por variante. Correr tal cual en el SQL Editor de
-- Supabase. Idempotente.
--
-- Una publicación con variantes (talles, colores) guarda su stock de Full con
-- un inventory_id por variante. Hasta ahora se guardaba solo el primero, así
-- que "Unidades en Full" y el capital inmovilizado quedaban cortos para esas
-- publicaciones. inventory_ids guarda todos; se completa en el próximo
-- Sincronizar. Sin correr esto la app sigue andando como antes.

ALTER TABLE products ADD COLUMN IF NOT EXISTS inventory_ids TEXT[] NOT NULL DEFAULT '{}';
