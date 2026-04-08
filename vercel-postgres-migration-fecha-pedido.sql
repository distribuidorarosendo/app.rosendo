-- Si ya tenías la tabla SIN fecha_pedido, ejecutá esto UNA VEZ en el SQL Editor de Neon.

ALTER TABLE items_pedido ADD COLUMN IF NOT EXISTS fecha_pedido date;

UPDATE items_pedido
SET fecha_pedido = (created_at AT TIME ZONE 'America/Argentina/Buenos_Aires')::date
WHERE fecha_pedido IS NULL;

UPDATE items_pedido SET fecha_pedido = CURRENT_DATE WHERE fecha_pedido IS NULL;

ALTER TABLE items_pedido ALTER COLUMN fecha_pedido SET DEFAULT CURRENT_DATE;
ALTER TABLE items_pedido ALTER COLUMN fecha_pedido SET NOT NULL;

CREATE INDEX IF NOT EXISTS items_pedido_fecha_idx ON items_pedido (fecha_pedido);
