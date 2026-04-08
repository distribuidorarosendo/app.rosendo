import { neon } from '@neondatabase/serverless';

const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;
const sql = connectionString ? neon(connectionString) : null;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(obj));
}

function getId(req) {
  if (req.query && typeof req.query.id === 'string') return req.query.id;
  try {
    const u = new URL(req.url || '/', 'http://localhost');
    return u.searchParams.get('id');
  } catch {
    return null;
  }
}

function getFecha(req) {
  let f = null;
  if (req.query && typeof req.query.fecha === 'string') f = req.query.fecha;
  if (!f) {
    try {
      f = new URL(req.url || '/', 'http://localhost').searchParams.get('fecha');
    } catch {
      /* ignore */
    }
  }
  if (!f || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;
  return f;
}

async function parseBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    return req.body;
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  if (!sql) {
    return sendJson(res, 503, {
      code: 'DB_CONFIG',
      message:
        'Falta la base de datos. En Vercel: Storage → conectá Postgres (Neon), revisá que exista DATABASE_URL o POSTGRES_URL, y redeploy.',
    });
  }

  try {
    if (req.method === 'GET') {
      const fecha = getFecha(req);
      if (!fecha) {
        return sendJson(res, 400, {
          error: 'Falta ?fecha=YYYY-MM-DD (día del pedido en tu calendario).',
        });
      }
      const rows = await sql`
        SELECT * FROM items_pedido
        WHERE fecha_pedido = ${fecha}::date
        ORDER BY updated_at DESC
      `;
      return sendJson(res, 200, rows);
    }

    if (req.method === 'POST') {
      const body = await parseBody(req);
      const proveedor = String(body.proveedor || '').trim();
      const producto = String(body.producto || '').trim();
      const quien = String(body.quien || '').trim();
      let fechaPedido = String(body.fecha_pedido || '').trim();
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaPedido)) {
        return sendJson(res, 400, { error: 'fecha_pedido obligatoria (YYYY-MM-DD)' });
      }
      if (!proveedor || !producto) {
        return sendJson(res, 400, { error: 'proveedor y producto son obligatorios' });
      }
      const rows = await sql`
        INSERT INTO items_pedido (fecha_pedido, proveedor, producto, estado, donde, quien, notas)
        VALUES (${fechaPedido}::date, ${proveedor}, ${producto}, 'pendiente', '', ${quien}, '')
        RETURNING *
      `;
      return sendJson(res, 201, rows[0]);
    }

    if (req.method === 'PATCH') {
      const id = getId(req);
      if (!id) {
        return sendJson(res, 400, { error: 'Falta ?id=' });
      }
      const body = await parseBody(req);
      const estado = body.estado;
      const donde = body.donde != null ? String(body.donde) : '';
      const quien = body.quien != null ? String(body.quien) : '';
      const notas = body.notas != null ? String(body.notas) : '';
      if (!['pendiente', 'comprado', 'conseguido'].includes(estado)) {
        return sendJson(res, 400, { error: 'estado inválido' });
      }
      const rows = await sql`
        UPDATE items_pedido
        SET
          estado = ${estado},
          donde = ${donde},
          quien = ${quien},
          notas = ${notas},
          updated_at = NOW()
        WHERE id = ${id}::uuid
        RETURNING *
      `;
      if (!rows.length) {
        return sendJson(res, 404, { error: 'No encontrado' });
      }
      return sendJson(res, 200, rows[0]);
    }

    if (req.method === 'DELETE') {
      const id = getId(req);
      if (!id) {
        return sendJson(res, 400, { error: 'Falta ?id=' });
      }
      const delRows = await sql`
        DELETE FROM items_pedido WHERE id = ${id}::uuid RETURNING id
      `;
      if (!delRows.length) {
        return sendJson(res, 404, { error: 'No encontrado' });
      }
      return sendJson(res, 200, { ok: true });
    }

    res.statusCode = 405;
    res.setHeader('Allow', 'GET, POST, PATCH, DELETE');
    return sendJson(res, 405, { error: 'Method not allowed' });
  } catch (e) {
    console.error(e);
    const msg = e.message || String(e);
    const low = msg.toLowerCase();
    if (low.includes('column') && low.includes('fecha_pedido')) {
      return sendJson(res, 503, {
        code: 'MIGRACION',
        message:
          'Falta la columna fecha_pedido. Ejecutá vercel-postgres-migration-fecha-pedido.sql en Neon y recargá.',
      });
    }
    if (low.includes('relation') && low.includes('does not exist')) {
      return sendJson(res, 503, {
        code: 'TABLA_FALTA',
        message:
          'Falta crear la tabla. Ejecutá vercel-postgres-schema.sql en el SQL Editor de tu base (Neon / Vercel Postgres).',
      });
    }
    if (
      low.includes('connect') ||
      low.includes('econnrefused') ||
      low.includes('fetch failed') ||
      low.includes('password authentication failed')
    ) {
      return sendJson(res, 503, {
        code: 'DB_CONFIG',
        message:
          'No se pudo conectar a la base. Revisá Storage → Postgres en Vercel y las variables de entorno.',
      });
    }
    return sendJson(res, 500, { error: 'SERVER', message: msg });
  }
}
