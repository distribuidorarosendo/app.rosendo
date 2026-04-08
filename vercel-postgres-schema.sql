-- Ejecutar en la base Postgres enlazada a Vercel (Neon u otro) → SQL Editor
-- Vercel → Storage → Postgres → abrir consola SQL
--
-- Si la tabla ya existía de antes: ejecutá también vercel-postgres-migration-fecha-pedido.sql

CREATE TABLE IF NOT EXISTS items_pedido (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  fecha_pedido DATE NOT NULL DEFAULT CURRENT_DATE,
  proveedor TEXT NOT NULL,
  producto TEXT NOT NULL,
  estado TEXT NOT NULL DEFAULT 'pendiente'
    CHECK (estado IN ('pendiente', 'comprado', 'conseguido')),
  donde TEXT NOT NULL DEFAULT '',
  quien TEXT NOT NULL DEFAULT '',
  notas TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS items_pedido_proveedor_idx ON items_pedido (proveedor);
CREATE INDEX IF NOT EXISTS items_pedido_fecha_idx ON items_pedido (fecha_pedido);
CREATE INDEX IF NOT EXISTS items_pedido_updated_idx ON items_pedido (updated_at DESC);
