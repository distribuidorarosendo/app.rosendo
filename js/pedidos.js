const API = '/api/pedidos';
const POLL_MS = 4000;

const LS_NOMBRE = 'pedidos_rosendo_nombre';

const el = {
  setup: document.getElementById('setup-banner'),
  setupDetail: document.getElementById('setup-detail'),
  app: document.getElementById('app'),
  nombre: document.getElementById('nombre'),
  proveedorFilter: document.getElementById('proveedor-filter'),
  proveedorNuevo: document.getElementById('proveedor-nuevo'),
  productoNuevo: document.getElementById('producto-nuevo'),
  btnAgregar: document.getElementById('btn-agregar'),
  lista: document.getElementById('lista'),
  status: document.getElementById('status-conn'),
  btnRecargarProv: document.getElementById('btn-recargar-proveedores'),
};

let proveedoresCache = [];
let itemsCache = [];
let pollTimer = null;

async function fetchProveedoresDesdeCatalogo() {
  try {
    const r = await fetch('assets/assets/data/productos_inicial.json');
    if (!r.ok) return [];
    const data = await r.json();
    const set = new Set();
    for (const p of data) {
      if (p.proveedor && String(p.proveedor).trim()) set.add(String(p.proveedor).trim());
    }
    return [...set].sort((a, b) => a.localeCompare(b, 'es'));
  } catch {
    return [];
  }
}

function fillProveedorSelects(list) {
  const prevFiltro = el.proveedorFilter.value;
  const prevNuevo = el.proveedorNuevo.value;
  proveedoresCache = list;
  const opts = ['<option value="">— Elegí proveedor —</option>']
    .concat(list.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`))
    .concat(['<option value="__otro__">Otro (escribir abajo)</option>']);
  const html = opts.join('');
  el.proveedorFilter.innerHTML =
    '<option value="">Todos los proveedores</option>' +
    list.map((p) => `<option value="${escapeAttr(p)}">${escapeHtml(p)}</option>`).join('');
  el.proveedorNuevo.innerHTML = html;
  if ([...el.proveedorFilter.options].some((o) => o.value === prevFiltro)) el.proveedorFilter.value = prevFiltro;
  if ([...el.proveedorNuevo.options].some((o) => o.value === prevNuevo)) el.proveedorNuevo.value = prevNuevo;
}

function mergeProveedoresFromItems() {
  const fromItems = [...new Set(itemsCache.map((i) => i.proveedor).filter(Boolean))];
  const merged = [...new Set([...proveedoresCache, ...fromItems])].sort((a, b) =>
    a.localeCompare(b, 'es')
  );
  if (merged.length !== proveedoresCache.length || merged.some((p, i) => p !== proveedoresCache[i])) {
    fillProveedorSelects(merged);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeAttr(s) {
  return escapeHtml(s).replace(/'/g, '&#39;');
}

function nombreQuien() {
  const n = (el.nombre.value || '').trim();
  if (n) localStorage.setItem(LS_NOMBRE, n);
  return n || 'Sin nombre';
}

function showSetup(message) {
  if (el.setupDetail) el.setupDetail.textContent = message || '';
  el.setup.hidden = false;
  el.app.hidden = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function showApp() {
  el.setup.hidden = true;
  el.app.hidden = false;
}

async function loadItems() {
  el.status.textContent = 'Sincronizando…';
  let r;
  try {
    r = await fetch(API);
  } catch (e) {
    el.status.textContent = 'No hay conexión con el servidor (¿abrís solo el HTML sin Vercel?)';
    showSetup(
      'Esta página necesita el backend en /api/pedidos (desplegá en Vercel o usá: vercel dev).'
    );
    return;
  }

  let data;
  try {
    data = await r.json();
  } catch {
    showSetup('Respuesta inválida del servidor.');
    return;
  }

  if (r.status === 503 && data.message) {
    showSetup(data.message);
    return;
  }

  if (!r.ok) {
    el.status.textContent = data.message || data.error || 'Error al cargar';
    if (r.status >= 500) showSetup(data.message || 'Error del servidor.');
    return;
  }

  if (!Array.isArray(data)) {
    showSetup('Formato de datos inesperado.');
    return;
  }

  showApp();
  itemsCache = data;
  mergeProveedoresFromItems();
  renderLista();
  el.status.textContent = `Conectado · actualización cada ${POLL_MS / 1000}s`;
}

function proveedorFiltroActual() {
  return el.proveedorFilter.value || '';
}

function renderLista() {
  const filtro = proveedorFiltroActual();
  let rows = itemsCache;
  if (filtro) rows = rows.filter((i) => i.proveedor === filtro);

  if (rows.length === 0) {
    el.lista.innerHTML =
      '<p class="empty">No hay ítems. Agregá uno arriba o cambiá el filtro de proveedor.</p>';
    return;
  }

  el.lista.innerHTML = rows
    .map((item) => {
      const badge =
        item.estado === 'pendiente'
          ? 'badge pendiente'
          : item.estado === 'comprado'
            ? 'badge comprado'
            : 'badge conseguido';
      const label =
        item.estado === 'pendiente'
          ? 'Pendiente'
          : item.estado === 'comprado'
            ? 'Comprado'
            : 'Conseguido';
      const donde = item.donde ? `<span class="donde">${escapeHtml(item.donde)}</span>` : '';
      const notas = item.notas ? `<p class="notas">${escapeHtml(item.notas)}</p>` : '';
      return `
      <article class="card" data-id="${item.id}">
        <div class="card-head">
          <span class="${badge}">${label}</span>
          <span class="prov-tag">${escapeHtml(item.proveedor)}</span>
        </div>
        <h3 class="producto">${escapeHtml(item.producto)}</h3>
        ${donde ? `<p class="meta-donde">📍 ${donde}</p>` : ''}
        <p class="quien">Último cambio: <strong>${escapeHtml(item.quien || '—')}</strong></p>
        ${notas}
        <div class="acciones">
          <button type="button" class="btn sm" data-act="pendiente" data-id="${item.id}">Pendiente</button>
          <button type="button" class="btn sm primary" data-act="comprado" data-id="${item.id}">Compré</button>
          <button type="button" class="btn sm accent" data-act="conseguido" data-id="${item.id}">Conseguí en…</button>
          <button type="button" class="btn sm danger" data-act="eliminar" data-id="${item.id}">Eliminar</button>
        </div>
      </article>`;
    })
    .join('');

  el.lista.querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', () => onAction(btn.dataset.act, btn.dataset.id));
  });
}

async function onAction(act, id) {
  const row = itemsCache.find((r) => r.id === id);
  if (!row) return;

  if (act === 'eliminar') {
    if (!confirm('¿Eliminar este ítem de la lista?')) return;
    const r = await fetch(`${API}?id=${encodeURIComponent(id)}`, { method: 'DELETE' });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      alert(j.message || j.error || 'Error al eliminar');
      return;
    }
    await loadItems();
    return;
  }

  let patch = {
    estado: row.estado,
    donde: row.donde || '',
    quien: nombreQuien(),
    notas: row.notas || '',
  };

  if (act === 'pendiente') {
    patch.estado = 'pendiente';
    patch.donde = '';
  } else if (act === 'comprado') {
    patch.estado = 'comprado';
    patch.donde = '';
  } else if (act === 'conseguido') {
    const lugar = prompt('¿Dónde lo conseguiste? (ej. Golomax, Barcelona)', row.donde || '');
    if (lugar === null) return;
    patch.estado = 'conseguido';
    patch.donde = (lugar || '').trim();
  }

  const r = await fetch(`${API}?id=${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(j.message || j.error || 'Error al guardar');
    return;
  }
  await loadItems();
}

async function agregarItem() {
  let prov = el.proveedorNuevo.value;
  if (prov === '__otro__') {
    prov = prompt('Nombre del proveedor / mayorista');
    if (prov === null) return;
    prov = (prov || '').trim();
  }
  const producto = (el.productoNuevo.value || '').trim();
  if (!prov || prov === '__otro__') {
    alert('Elegí un proveedor.');
    return;
  }
  if (!producto) {
    alert('Escribí qué producto es.');
    return;
  }

  const r = await fetch(API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      proveedor: prov,
      producto,
      quien: nombreQuien(),
    }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    alert(j.message || j.error || 'Error al agregar');
    return;
  }
  el.productoNuevo.value = '';
  await loadItems();
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (el.app.hidden) return;
    loadItems();
  }, POLL_MS);
}

async function init() {
  const saved = localStorage.getItem(LS_NOMBRE);
  if (saved) el.nombre.value = saved;

  el.nombre.addEventListener('change', () => nombreQuien());
  el.proveedorFilter.addEventListener('change', renderLista);
  el.btnAgregar.addEventListener('click', agregarItem);
  el.btnRecargarProv.addEventListener('click', async () => {
    const list = await fetchProveedoresDesdeCatalogo();
    fillProveedorSelects(list);
    mergeProveedoresFromItems();
  });

  const catalog = await fetchProveedoresDesdeCatalogo();
  fillProveedorSelects(catalog);
  await loadItems();
  startPolling();
}

init();
