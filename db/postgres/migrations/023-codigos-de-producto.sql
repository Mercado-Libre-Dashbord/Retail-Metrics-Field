-- 023 · SKU de variantes y códigos de barras (EAN/GTIN) de cada publicación.
-- Sirven para cruzar la planilla de costos del vendedor con sus publicaciones
-- (Productos → Importar costos). Se llenan en la próxima sincronización.
ALTER TABLE products ADD COLUMN IF NOT EXISTS skus TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE products ADD COLUMN IF NOT EXISTS gtins TEXT[] NOT NULL DEFAULT '{}';
