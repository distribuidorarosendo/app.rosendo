/** Cliente compartido para /api/pedidos (Neon / Vercel). */
export const API = '/api/pedidos';
export const LS_NOMBRE = 'pedidos_rosendo_nombre';

export function fechaLocalHoy() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function getNombre() {
  return (localStorage.getItem(LS_NOMBRE) || '').trim();
}

export function setNombre(n) {
  const t = String(n || '').trim();
  if (t) localStorage.setItem(LS_NOMBRE, t);
  else localStorage.removeItem(LS_NOMBRE);
}

export async function apiGetPedidos(fecha) {
  const r = await fetch(`${API}?fecha=${encodeURIComponent(fecha)}`);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  if (!Array.isArray(data)) throw new Error('Respuesta inválida');
  return data;
}

export async function apiPostPedido({ fecha_pedido, proveedor, producto, quien, cantidad }) {
  const body = { fecha_pedido, proveedor, producto, quien };
  if (cantidad != null) body.cantidad = cantidad;
  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

export async function apiPatchPedido(id, body) {
  const r = await fetch(`${API}?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

export async function apiDeletePedido(id) {
  const r = await fetch(`${API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || data.error || `HTTP ${r.status}`);
  return data;
}

/** Unidades típicas del texto del catálogo: "(12)" al final. */
export function unidadesDesdeNombre(nombre) {
  const m = String(nombre).match(/\((\d+)\)\s*$/);
  return m ? parseInt(m[1], 10) : 1;
}
