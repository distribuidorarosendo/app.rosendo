-- Cantidad por línea de pedido (una fila = un producto+proveedor con N unidades).
-- Ejecutar en Neon / SQL Editor después del schema base.

ALTER TABLE items_pedido
  ADD COLUMN IF NOT EXISTS cantidad INTEGER NOT NULL DEFAULT 1;
