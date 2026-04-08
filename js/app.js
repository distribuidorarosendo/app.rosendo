import {
  fechaLocalHoy,
  getNombre,
  setNombre,
  apiGetPedidos,
  apiPostPedido,
  apiPatchPedido,
  apiDeletePedido,
  unidadesDesdeNombre,
} from './pedidos-api.js';

const CATALOG_URL = 'assets/assets/data/productos_inicial.json';
const LS_REMITO = 'rosendo_remito_borrador';
const LS_REMITO_HISTORIAL = 'rosendo_remito_historial';
const REMITO_HISTORIAL_MAX = 10;
const POLL_MS = 8000;

let catalog = [];
/** @type {Map<string, { nombre: string, proveedor: string, pasillo: string | null, marca: string, categoria: string }>} */
const catalogByNorm = new Map();

let itemsToday = [];
let pollTimer = null;
let searchDebounce = null;
let debounceProductos = null;
let debounceProveedores = null;

const CATALOG_LIST_CAP_BROWSE = 100;
const CATALOG_LIST_CAP_FILTER = 200;
const PROV_PROD_CAP = 120;

const LS_CAT_OVR = 'rosendo_catalog_overrides';
const LS_CAT_CUSTOM = 'rosendo_catalog_custom';

/** @type {Set<string>} */
let baseProductIds = new Set();

function readJsonLs(key, fallback) {
  try {
    const t = localStorage.getItem(key);
    if (t == null || t === '') return fallback;
    const v = JSON.parse(t);
    return v != null ? v : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonLs(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function mergeCatalogFromStorage(base) {
  const overrides = readJsonLs(LS_CAT_OVR, {});
  const customs = readJsonLs(LS_CAT_CUSTOM, []);
  const mergedBase = base.map((p) => {
    const o = overrides[p.id];
    if (!o) {
      return {
        ...p,
        marca: p.marca != null ? String(p.marca) : '',
        categoria: p.categoria != null ? String(p.categoria) : '',
      };
    }
    return {
      ...p,
      nombre: o.nombre != null ? o.nombre : p.nombre,
      proveedor: o.proveedor != null ? o.proveedor : p.proveedor,
      pasillo:
        o.pasillo !== undefined
          ? o.pasillo != null && String(o.pasillo).trim()
            ? String(o.pasillo).trim()
            : null
          : p.pasillo,
      marca: o.marca != null ? String(o.marca) : p.marca || '',
      categoria: o.categoria != null ? String(o.categoria) : p.categoria || '',
    };
  });
  const extras = customs.map((c) => ({
    id: c.id,
    nombre: c.nombre,
    proveedor: String(c.proveedor || '').trim() || '—',
    pasillo: c.pasillo != null && String(c.pasillo).trim() ? String(c.pasillo).trim() : null,
    marca: c.marca != null ? String(c.marca) : '',
    categoria: c.categoria != null ? String(c.categoria) : '',
  }));
  return [...mergedBase, ...extras];
}

function productMatchesFilter(p, qq) {
  if (!qq) return true;
  return (
    norm(p.nombre).includes(qq) ||
    norm(String(p.proveedor || '')).includes(qq) ||
    norm(String(p.pasillo || '')).includes(qq) ||
    norm(String(p.marca || '')).includes(qq) ||
    norm(String(p.categoria || '')).includes(qq)
  );
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function el(id) {
  return document.getElementById(id);
}

function metaForProducto(nombreProducto) {
  return (
    catalogByNorm.get(norm(nombreProducto)) || {
      pasillo: null,
      marca: '',
      categoria: '',
    }
  );
}

function rebuildCatalogByNorm() {
  catalogByNorm.clear();
  for (const p of catalog) {
    const n = norm(p.nombre);
    if (!n) continue;
    catalogByNorm.set(n, {
      nombre: p.nombre,
      proveedor: String(p.proveedor || '').trim() || '—',
      pasillo: p.pasillo != null && String(p.pasillo).trim() ? String(p.pasillo).trim() : null,
      marca: p.marca != null ? String(p.marca) : '',
      categoria: p.categoria != null ? String(p.categoria) : '',
    });
  }
}

async function loadCatalog() {
  const r = await fetch(CATALOG_URL);
  if (!r.ok) throw new Error('No se pudo cargar el catálogo');
  const base = await r.json();
  baseProductIds = new Set(base.map((p) => String(p.id || '')));
  catalog = mergeCatalogFromStorage(base);
  rebuildCatalogByNorm();
}

function fecha() {
  return fechaLocalHoy();
}

function lineQty(it) {
  const c = Number(it.cantidad ?? 1);
  if (Number.isNaN(c) || c < 1) return 1;
  return Math.min(999, c);
}

function countEnPedidoProducto(p) {
  const pr = String(p.proveedor || '').trim() || '—';
  let n = 0;
  for (const it of itemsToday) {
    if (norm(it.producto) === norm(p.nombre) && norm(it.proveedor) === norm(pr)) {
      n += lineQty(it);
    }
  }
  return n;
}

function updateBuscarNuevoFooter() {
  const span = el('buscar-pedido-count');
  if (!span) return;
  let t = 0;
  for (const it of itemsToday) t += lineQty(it);
  span.textContent = String(t);
}

function updateStats() {
  const n = itemsToday.length;
  let u = 0;
  for (const it of itemsToday) {
    u += unidadesDesdeNombre(it.producto) * lineQty(it);
  }
  const uniqProd = new Set(itemsToday.map((it) => norm(it.producto))).size;
  el('stat-items').textContent = String(n);
  el('stat-unidades').textContent = String(u);
  const si = el('sidebar-items');
  const sp = el('sidebar-productos');
  if (si) si.textContent = String(n);
  if (sp) sp.textContent = String(uniqProd);
  el('footer-stats').textContent = `${n} PRODUCTO${n === 1 ? '' : 'S'} — ${u} UNIDADE${u === 1 ? '' : 'S'}`;
  updateBuscarNuevoFooter();
}

async function refreshPedido() {
  const banner = el('setup-banner');
  try {
    itemsToday = await apiGetPedidos(fecha());
    banner.hidden = true;
    banner.textContent = '';
  } catch (e) {
    banner.hidden = false;
    banner.textContent = e.message || String(e);
    itemsToday = [];
  }
  updateStats();
  if (!el('view-lista').hidden) renderLista();
  if (!el('view-resumen').hidden) renderResumen();
  if (!el('view-productos').hidden) renderProductos();
  if (!el('view-proveedores').hidden) renderProveedores();
  if (!el('view-buscar').hidden) renderSearchResults();
}

function filterCatalog(q) {
  const qq = norm(q);
  if (!qq) return [];
  return catalog.filter((p) => productMatchesFilter(p, qq)).slice(0, 80);
}

function renderSearchResults() {
  const q = el('q').value;
  const list = el('search-results');
  const empty = el('search-empty');
  const rows = filterCatalog(q);
  if (!q.trim()) {
    list.hidden = true;
    empty.hidden = true;
    list.innerHTML = '';
    return;
  }
  if (rows.length === 0) {
    list.hidden = true;
    empty.hidden = false;
    list.innerHTML = '';
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  list.innerHTML = rows
    .map((p) => {
      const prov = escapeHtml(String(p.proveedor || ''));
      const nom = escapeHtml(p.nombre);
      const id = escapeHtml(p.id || '');
      const enP = countEnPedidoProducto(p);
      const pasRaw = p.pasillo != null && String(p.pasillo).trim() ? String(p.pasillo).trim() : '';
      const pasLine = pasRaw
        ? `<div class="catalog-pas-line">Pasillo ${escapeHtml(pasRaw)}</div>`
        : '';
      const mar = String(p.marca || '').trim();
      const cat = String(p.categoria || '').trim();
      const extra = [mar, cat].filter(Boolean).map(escapeHtml).join(' · ');
      const extraLine = extra ? `<div class="catalog-extra-line">${extra}</div>` : '';
      const enLine =
        enP > 0 ? `<div class="buscar-en-pedido">En pedido: ${enP}</div>` : '';
      const qtyNum = enP > 0 ? `<span class="buscar-qty-num">${enP}</span>` : '';
      const rowClass = enP > 0 ? ' in-pedido' : '';
      return `<li data-id="${id}" class="buscar-result-row${rowClass}">
        <div class="buscar-row-text">
          <div class="buscar-row-title">${nom}</div>
          <div class="buscar-row-meta">${prov}</div>
          ${pasLine}
          ${extraLine}
          ${enLine}
        </div>
        <div class="buscar-row-actions">
          ${qtyNum}
          <button type="button" class="btn-add-round btn-add-catalog" aria-label="Agregar al pedido">+</button>
        </div>
      </li>`;
    })
    .join('');
}

function catalogPorProveedor() {
  /** @type {Map<string, object[]>} */
  const m = new Map();
  for (const p of catalog) {
    const pr = String(p.proveedor || '').trim() || '—';
    if (!m.has(pr)) m.set(pr, []);
    m.get(pr).push(p);
  }
  return m;
}

function renderProductos() {
  const list = el('productos-list');
  const empty = el('productos-empty');
  const capEl = el('productos-caption');
  if (!list || !empty || !capEl) return;
  const qq = norm(el('q-productos').value);
  let rows = [...catalog];
  if (qq) {
    rows = rows.filter((p) => productMatchesFilter(p, qq));
  }
  rows.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
  const totalMatching = rows.length;
  if (!qq) {
    rows = rows.slice(0, CATALOG_LIST_CAP_BROWSE);
  } else {
    rows = rows.slice(0, CATALOG_LIST_CAP_FILTER);
  }
  if (totalMatching === 0) {
    list.innerHTML = '';
    list.hidden = true;
    empty.hidden = false;
    capEl.hidden = true;
    return;
  }
  empty.hidden = true;
  list.hidden = false;
  if (!qq && catalog.length > CATALOG_LIST_CAP_BROWSE) {
    capEl.textContent = `Mostrando los primeros ${CATALOG_LIST_CAP_BROWSE} de ${catalog.length}. Escribí para acotar.`;
    capEl.hidden = false;
  } else if (qq && totalMatching > CATALOG_LIST_CAP_FILTER) {
    capEl.textContent = `Mostrando ${CATALOG_LIST_CAP_FILTER} de ${totalMatching}. Afiná el filtro.`;
    capEl.hidden = false;
  } else {
    capEl.hidden = true;
  }
  list.innerHTML = rows
    .map((p) => {
      const prov = escapeHtml(String(p.proveedor || ''));
      const pasRaw = p.pasillo != null && String(p.pasillo).trim() ? String(p.pasillo).trim() : '';
      const pasLine = pasRaw
        ? `<div class="catalog-pas-line">Pasillo ${escapeHtml(pasRaw)}</div>`
        : '';
      const mar = String(p.marca || '').trim();
      const cat = String(p.categoria || '').trim();
      const extra = [mar, cat].filter(Boolean).map(escapeHtml).join(' · ');
      const extraLine = extra ? `<div class="catalog-extra-line">${extra}</div>` : '';
      const nom = escapeHtml(p.nombre);
      const id = escapeHtml(p.id || '');
      const enP = countEnPedidoProducto(p);
      const enLine =
        enP > 0 ? `<div class="buscar-en-pedido">En pedido: ${enP}</div>` : '';
      const qtyNum = enP > 0 ? `<span class="buscar-qty-num">${enP}</span>` : '';
      const rowClass = enP > 0 ? ' in-pedido' : '';
      return `<li data-id="${id}" class="catalog-prod-row buscar-result-row${rowClass}">
        <button type="button" class="catalog-row-tap" aria-label="Editar producto">
          <div class="buscar-row-text">
            <div class="buscar-row-title">${nom}</div>
            <div class="buscar-row-meta">${prov}</div>
            ${pasLine}
            ${extraLine}
            ${enLine}
          </div>
          <span class="catalog-chevron" aria-hidden="true">›</span>
        </button>
        <div class="buscar-row-actions">
          ${qtyNum}
          <button type="button" class="btn-add-round btn-add-catalog" aria-label="Agregar al pedido">+</button>
        </div>
      </li>`;
    })
    .join('');
}

function renderProveedores() {
  const mount = el('proveedores-mount');
  if (!mount) return;
  const q = norm(el('q-proveedores').value);
  const byProv = catalogPorProveedor();
  let keys = [...byProv.keys()].sort((a, b) => a.localeCompare(b, 'es'));
  if (q) keys = keys.filter((k) => norm(k).includes(q));
  if (keys.length === 0) {
    mount.innerHTML = '<p class="empty-msg">No hay proveedores que coincidan.</p>';
    return;
  }
  mount.innerHTML = keys
    .map((prov) => {
      const arr = byProv.get(prov).sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));
      const n = arr.length;
      const slice = arr.slice(0, PROV_PROD_CAP);
      const more =
        n > PROV_PROD_CAP
          ? `<p class="hint prov-prod-more">…y ${n - PROV_PROD_CAP} más. Filtrá en <strong>Productos</strong> por proveedor.</p>`
          : '';
      const rows = slice
        .map((p) => {
          const id = escapeHtml(p.id || '');
          const nom = escapeHtml(p.nombre);
          const enP = countEnPedidoProducto(p);
          const qtyNum = enP > 0 ? `<span class="buscar-qty-num buscar-qty-num--sm">${enP}</span>` : '';
          return `<li data-id="${id}" class="prov-prod-row">
          <span class="prov-prod-name">${nom}</span>
          <div class="buscar-row-actions">
            ${qtyNum}
            <button type="button" class="btn-add-round btn-add-catalog btn-add-tiny" aria-label="Agregar al pedido">+</button>
          </div>
        </li>`;
        })
        .join('');
      return `<details class="prov-block">
      <summary class="prov-block-sum"><span>${escapeHtml(prov)}</span><span class="prov-count">${n} producto${n === 1 ? '' : 's'}</span></summary>
      <ul class="prov-prod-list">${rows}</ul>
      ${more}
    </details>`;
    })
    .join('');
}

function closeSidebar() {
  const sh = el('shell');
  if (sh) sh.classList.remove('nav-open');
}

function openProductEdit(id) {
  const p = catalog.find((x) => String(x.id) === String(id));
  if (!p) return;
  el('pe-id').value = p.id;
  el('pe-nombre').value = p.nombre;
  el('pe-proveedor').value = String(p.proveedor || '').trim();
  el('pe-pasillo').value = p.pasillo != null ? String(p.pasillo) : '';
  el('pe-marca').value = p.marca != null ? String(p.marca) : '';
  el('pe-categoria').value = p.categoria != null ? String(p.categoria) : '';
  showView('producto-edit', { isNew: false });
}

function openNewProduct() {
  el('pe-id').value = '';
  el('pe-nombre').value = '';
  el('pe-proveedor').value = '';
  el('pe-pasillo').value = '';
  el('pe-marca').value = '';
  el('pe-categoria').value = '';
  showView('producto-edit', { isNew: true });
}

async function saveProductCatalogFromForm(e) {
  e.preventDefault();
  const id = el('pe-id').value.trim();
  const nombre = el('pe-nombre').value.trim();
  const proveedor = el('pe-proveedor').value.trim();
  if (!nombre || !proveedor) {
    alert('Completá nombre y proveedor (obligatorios).');
    return;
  }
  const pasilloRaw = el('pe-pasillo').value.trim();
  const marca = el('pe-marca').value.trim();
  const categoria = el('pe-categoria').value.trim();
  const pasillo = pasilloRaw ? pasilloRaw : null;

  if (!id) {
    const arr = readJsonLs(LS_CAT_CUSTOM, []);
    arr.push({
      id: `local-${Date.now()}`,
      nombre,
      proveedor,
      pasillo,
      marca,
      categoria,
    });
    writeJsonLs(LS_CAT_CUSTOM, arr);
  } else if (String(id).startsWith('local-')) {
    const arr = readJsonLs(LS_CAT_CUSTOM, []);
    const i = arr.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) {
      arr[i] = { ...arr[i], nombre, proveedor, pasillo, marca, categoria };
      writeJsonLs(LS_CAT_CUSTOM, arr);
    }
  } else if (baseProductIds.has(String(id))) {
    const ovr = readJsonLs(LS_CAT_OVR, {});
    ovr[id] = { nombre, proveedor, pasillo, marca, categoria };
    writeJsonLs(LS_CAT_OVR, ovr);
  } else {
    const arr = readJsonLs(LS_CAT_CUSTOM, []);
    const i = arr.findIndex((x) => String(x.id) === String(id));
    if (i >= 0) {
      arr[i] = { ...arr[i], nombre, proveedor, pasillo, marca, categoria };
      writeJsonLs(LS_CAT_CUSTOM, arr);
    }
  }

  try {
    await loadCatalog();
  } catch (err) {
    alert(err.message || String(err));
    return;
  }
  showView('productos');
  renderProductos();
  if (!el('view-buscar').hidden) renderSearchResults();
  if (!el('view-proveedores').hidden) renderProveedores();
}

function syncSidebarNav(v) {
  document.querySelectorAll('.nav-item[data-nav]').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.nav === v);
  });
}

function showView(v, opts = {}) {
  const buscarNav = opts.buscarNav || 'buscar';
  el('view-home').hidden = v !== 'home';
  el('view-buscar').hidden = v !== 'buscar';
  el('view-productos').hidden = v !== 'productos';
  el('view-producto-edit').hidden = v !== 'producto-edit';
  el('view-proveedores').hidden = v !== 'proveedores';
  el('view-lista').hidden = v !== 'lista';
  el('view-resumen').hidden = v !== 'resumen';
  el('view-remito').hidden = v !== 'remito';
  const shell = el('shell');
  if (shell) {
    shell.classList.toggle('view-buscar', v === 'buscar');
    shell.classList.toggle('view-nuevo-pedido', v === 'buscar' && buscarNav === 'nuevo');
    shell.classList.toggle('producto-editing', v === 'producto-edit');
    shell.classList.toggle('view-producto-edit-bar', v === 'producto-edit');
  }
  const back = el('btn-back');
  if (back) back.hidden = v === 'home';
  const sub = el('bar-sub');
  if (v === 'home') {
    el('bar-title').textContent = 'DEPÓSITO';
    sub.textContent = 'Sistema de restock';
    sub.hidden = false;
    syncSidebarNav('home');
  } else if (v === 'buscar') {
    el('bar-title').textContent = buscarNav === 'nuevo' ? 'NUEVO PEDIDO' : 'BUSCAR PRODUCTO';
    sub.hidden = true;
    el('q').placeholder =
      buscarNav === 'nuevo'
        ? 'Buscar producto por nombre, marca…'
        : 'Nombre del producto…';
    const foot = el('buscar-footer-nuevo');
    if (foot) foot.hidden = buscarNav !== 'nuevo';
    syncSidebarNav(buscarNav === 'nuevo' ? 'nuevo' : 'buscar');
    renderSearchResults();
    updateBuscarNuevoFooter();
  } else if (v === 'productos') {
    el('bar-title').textContent = 'PRODUCTOS';
    sub.textContent = 'Catálogo';
    sub.hidden = false;
    syncSidebarNav('productos');
    renderProductos();
  } else if (v === 'producto-edit') {
    el('bar-title').textContent = opts.isNew ? 'NUEVO PRODUCTO' : 'EDITAR PRODUCTO';
    sub.hidden = true;
    syncSidebarNav('productos');
  } else if (v === 'proveedores') {
    el('bar-title').textContent = 'PROVEEDORES';
    sub.textContent = 'Catálogo';
    sub.hidden = false;
    syncSidebarNav('proveedores');
    renderProveedores();
  } else if (v === 'lista') {
    el('bar-title').textContent = 'LISTA DE PEDIDO';
    sub.hidden = true;
    el('lista-fecha-lbl').textContent = fecha();
    renderLista();
    syncSidebarNav('lista');
  } else if (v === 'resumen') {
    el('bar-title').textContent = 'EXPORTAR / IMPRIMIR';
    sub.textContent = 'Resumen por proveedor';
    sub.hidden = false;
    renderResumen();
    syncSidebarNav('resumen');
  } else if (v === 'remito') {
    el('bar-title').textContent = 'REMITO';
    sub.hidden = true;
    el('remito-text').value = localStorage.getItem(LS_REMITO) || '';
    syncSidebarNav('remito');
  }
  closeSidebar();
}

function renderLista() {
  const mount = el('lista-mount');
  const btnLimpiar = el('btn-limpiar-lista');
  if (itemsToday.length === 0) {
    mount.innerHTML =
      '<p class="empty-msg">No hay ítems hoy. Usá <strong>Buscar productos</strong> o <strong>Nuevo pedido</strong> en el menú para agregar.</p>';
    if (btnLimpiar) btnLimpiar.hidden = true;
    return;
  }
  if (btnLimpiar) btnLimpiar.hidden = false;
  const sorted = [...itemsToday].sort((a, b) =>
    (a.proveedor || '').localeCompare(b.proveedor || '', 'es')
  );
  mount.innerHTML = sorted
    .map((item) => {
      const badge =
        item.estado === 'pendiente'
          ? 'pendiente'
          : item.estado === 'comprado'
            ? 'comprado'
            : 'conseguido';
      const label =
        item.estado === 'pendiente'
          ? 'Pendiente'
          : item.estado === 'comprado'
            ? 'Comprado'
            : 'Conseguido';
      const donde = item.donde ? `<div class="lista-donde">📍 ${escapeHtml(item.donde)}</div>` : '';
      const q = lineQty(item);
      return `<div class="lista-item lista-item-sheet" data-id="${item.id}">
        <div class="lista-sheet-row">
          <div class="lista-sheet-main">
            <div class="lista-prod-name">${escapeHtml(item.producto)}</div>
            <div class="lista-prod-meta">${escapeHtml(item.proveedor)} · ${q} un.</div>
            ${donde}
            <div class="lista-quien-hint">Último: ${escapeHtml(item.quien || '—')}</div>
          </div>
          <div class="lista-sheet-ic">
            <span class="lista-qty-big" aria-hidden="true">${q}</span>
            <button type="button" class="lista-ic-btn" data-act="editar-cant" aria-label="Editar cantidad">✎</button>
            <button type="button" class="lista-ic-btn lista-ic-danger" data-act="eliminar" aria-label="Eliminar">🗑</button>
          </div>
        </div>
        <div class="lista-sheet-estado">
          <span class="badge ${badge}">${label}</span>
          <div class="lista-actions lista-actions-compact">
            <button type="button" class="btn-sm" data-act="pendiente">Pendiente</button>
            <button type="button" class="btn-sm primary" data-act="comprado">Compré</button>
            <button type="button" class="btn-sm accent" data-act="conseguido">Conseguí en…</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/** @returns {null | { sections: { proveedor: string, pasillos: { label: string, items: { producto: string, qty: number }[] }[] }[] }} */
function computeResumenTree() {
  if (itemsToday.length === 0) return null;
  const byProv = new Map();
  for (const item of itemsToday) {
    const prov = (item.proveedor || '—').trim();
    if (!byProv.has(prov)) byProv.set(prov, []);
    const pas =
      metaForProducto(item.producto).pasillo != null
        ? `Pasillo ${metaForProducto(item.producto).pasillo}`
        : 'Sin pasillo';
    byProv.get(prov).push({ ...item, pasilloLabel: pas });
  }
  const provs = [...byProv.keys()].sort((a, b) => a.localeCompare(b, 'es'));
  const sections = [];
  for (const prov of provs) {
    const rows = byProv.get(prov);
    const byPas = new Map();
    for (const r of rows) {
      if (!byPas.has(r.pasilloLabel)) byPas.set(r.pasilloLabel, []);
      byPas.get(r.pasilloLabel).push(r);
    }
    const pases = [...byPas.keys()].sort((a, b) => a.localeCompare(b, 'es'));
    const pasillos = pases.map((pas) => ({
      label: pas,
      items: byPas
        .get(pas)
        .sort((a, b) => (a.producto || '').localeCompare(b.producto || '', 'es'))
        .map((r) => ({ producto: r.producto, qty: lineQty(r) })),
    }));
    sections.push({ proveedor: prov, pasillos });
  }
  return { sections };
}

function buildResumenPlainText() {
  const tree = computeResumenTree();
  if (!tree) return '';
  const lines = [
    'REPASO DEPÓSITO',
    `Fecha del pedido: ${fecha()}`,
    `Generado: ${new Date().toLocaleString('es-AR')}`,
    '',
  ];
  for (const sec of tree.sections) {
    lines.push(`-- ${sec.proveedor} --`);
    lines.push('');
    for (const block of sec.pasillos) {
      lines.push(block.label);
      for (const it of block.items) {
        lines.push(`  ${it.producto}: ${it.qty}`);
      }
      lines.push('');
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function escapeCsvCell(s) {
  const t = String(s).replace(/"/g, '""');
  if (/[",\n\r]/.test(t)) return `"${t}"`;
  return t;
}

function buildResumenCsv() {
  const tree = computeResumenTree();
  if (!tree) return '';
  const rows = [['Proveedor', 'Pasillo / ubicación', 'Producto', 'Cantidad']];
  for (const sec of tree.sections) {
    for (const block of sec.pasillos) {
      for (const it of block.items) {
        rows.push([sec.proveedor, block.label, it.producto, String(it.qty)]);
      }
    }
  }
  return rows.map((r) => r.map(escapeCsvCell).join(',')).join('\r\n');
}

function renderResumen() {
  const mount = el('resumen-mount');
  const actions = el('resumen-actions');
  const tree = computeResumenTree();
  if (!tree) {
    mount.innerHTML = '<p class="empty-msg">No hay datos para resumir.</p>';
    if (actions) actions.hidden = true;
    return;
  }
  if (actions) actions.hidden = false;
  let html = '';
  for (const sec of tree.sections) {
    html += `<section class="prov-section"><h2 class="prov-title">${escapeHtml(sec.proveedor)}</h2>`;
    for (const block of sec.pasillos) {
      html += `<div class="pasillo-sub">${escapeHtml(block.label)}</div>`;
      for (const it of block.items) {
        html += `<div class="resumen-row"><span>${escapeHtml(it.producto)}</span><span class="resumen-qty">${it.qty}</span></div>`;
      }
    }
    html += '</section>';
  }
  mount.innerHTML = html;
}

function openResumenPrintWindow() {
  const body = escapeHtml(buildResumenPlainText());
  const html = `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><title>Resumen — ${escapeHtml(fecha())}</title>
<style>
  body{font-family:system-ui,-apple-system,sans-serif;padding:1.2rem;font-size:11pt;color:#111;}
  h1{font-size:13pt;margin:0 0 0.75rem;}
  pre{white-space:pre-wrap;word-break:break-word;font-family:inherit;margin:0;line-height:1.45;}
</style></head><body>
<h1>REPASO DEPÓSITO — ${escapeHtml(fecha())}</h1>
<pre>${body}</pre>
</body></html>`;
  const w = window.open('', '_blank');
  if (!w) {
    alert('Permití ventanas emergentes para imprimir o ver la vista previa.');
    return;
  }
  w.document.write(html);
  w.document.close();
  w.onload = () => {
    w.focus();
    w.print();
  };
}

async function resumenShareOrDownloadPdf() {
  const text = buildResumenPlainText();
  if (!text) {
    alert('No hay datos en el resumen.');
    return;
  }
  let blob = null;
  try {
    const mod = await import('https://esm.sh/jspdf@2.5.1');
    const JsPDF = mod.jsPDF || mod.default?.jsPDF || mod.default;
    if (typeof JsPDF !== 'function') {
      throw new Error('jsPDF no disponible');
    }
    const doc = new JsPDF({ unit: 'mm', format: 'a4' });
    doc.setFontSize(9);
    const lines = doc.splitTextToSize(text, 180);
    let y = 12;
    const step = 4.2;
    for (const line of lines) {
      if (y > 285) {
        doc.addPage();
        y = 12;
      }
      doc.text(line, 14, y);
      y += step;
    }
    blob = doc.output('blob');
  } catch (e) {
    console.warn('PDF:', e);
  }
  const name = `resumen-deposito-${fecha()}.pdf`;
  if (blob && navigator.canShare && navigator.canShare({ files: [new File([blob], name, { type: 'application/pdf' })] })) {
    try {
      await navigator.share({
        files: [new File([blob], name, { type: 'application/pdf' })],
        title: 'Resumen proveedores',
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  if (blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    return;
  }
  openResumenPrintWindow();
  alert(
    'No se pudo generar el PDF automático. Se abrió la vista para imprimir: en el celular podés elegir «Guardar como PDF» o compartir desde el menú del navegador.'
  );
}

function resumenDownloadCsv() {
  const csv = buildResumenCsv();
  if (!csv) {
    alert('No hay datos en el resumen.');
    return;
  }
  const blob = new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' });
  const name = `resumen-proveedores-${fecha()}.csv`;
  const file = new File([blob], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Resumen Excel' }).catch((err) => {
      if (err.name !== 'AbortError') fallbackDownloadBlob(blob, name);
    });
    return;
  }
  fallbackDownloadBlob(blob, name);
}

function fallbackDownloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function resumenCopyText() {
  const t = buildResumenPlainText();
  if (!t) {
    alert('No hay datos en el resumen.');
    return;
  }
  try {
    await navigator.clipboard.writeText(t);
    alert('Copiado al portapapeles.');
  } catch {
    prompt('Copiá este texto (Ctrl+C):', t);
  }
}

async function resumenShareText() {
  const t = buildResumenPlainText();
  if (!t) {
    alert('No hay datos en el resumen.');
    return;
  }
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Resumen depósito ${fecha()}`,
        text: t,
      });
      return;
    } catch (err) {
      if (err.name === 'AbortError') return;
    }
  }
  await resumenCopyText();
}

async function agregarCatalogo(nombre, proveedor, cantidadAdd = 1) {
  const quien = getNombre();
  if (!quien) return;
  const cAdd = Math.max(1, Math.min(999, parseInt(String(cantidadAdd), 10) || 1));
  const prov = String(proveedor || '').trim() || '—';
  const existing = itemsToday.find(
    (it) => norm(it.producto) === norm(nombre) && norm(it.proveedor) === norm(prov)
  );
  if (existing) {
    const next = Math.min(999, lineQty(existing) + cAdd);
    await apiPatchPedido(existing.id, {
      estado: existing.estado,
      donde: existing.donde || '',
      quien: getNombre(),
      notas: existing.notas || '',
      cantidad: next,
    });
  } else {
    await apiPostPedido({
      fecha_pedido: fecha(),
      proveedor: prov,
      producto: nombre,
      quien,
      cantidad: cAdd,
    });
  }
  await refreshPedido();
}

async function onListaAction(act, id) {
  const row = itemsToday.find((r) => r.id === id);
  if (!row) return;
  if (act === 'eliminar') {
    if (!confirm('¿Eliminar este ítem?')) return;
    await apiDeletePedido(id);
    await refreshPedido();
    return;
  }
  let patch = {
    estado: row.estado,
    donde: row.donde || '',
    quien: getNombre(),
    notas: row.notas || '',
    cantidad: lineQty(row),
  };
  if (act === 'editar-cant') {
    const cur = lineQty(row);
    const v = prompt('Cantidad', String(cur));
    if (v === null) return;
    const n = parseInt(v, 10);
    if (Number.isNaN(n) || n < 1 || n > 999) {
      alert('Cantidad entre 1 y 999.');
      return;
    }
    patch.cantidad = n;
    await apiPatchPedido(id, patch);
    await refreshPedido();
    return;
  }
  if (act === 'pendiente') {
    patch.estado = 'pendiente';
    patch.donde = '';
  } else if (act === 'comprado') {
    patch.estado = 'comprado';
    patch.donde = '';
  } else if (act === 'conseguido') {
    const lugar = prompt('¿Dónde lo conseguiste?', row.donde || '');
    if (lugar === null) return;
    patch.estado = 'conseguido';
    patch.donde = (lugar || '').trim();
  }
  await apiPatchPedido(id, patch);
  await refreshPedido();
}

function startPoll() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(() => {
    if (el('shell').hidden) return;
    refreshPedido();
  }, POLL_MS);
}

function openNombreGate() {
  el('nombre-gate').hidden = false;
  el('shell').hidden = true;
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

function closeNombreGate() {
  el('nombre-gate').hidden = true;
  el('shell').hidden = false;
  el('nombre-line').innerHTML =
    'Trabajando como <strong>' +
    escapeHtml(getNombre()) +
    '</strong> · <a href="#" id="link-cambiar-nombre">Cambiar</a>';
  el('link-cambiar-nombre').addEventListener('click', (e) => {
    e.preventDefault();
    if (!confirm('¿Cambiar de persona?')) return;
    setNombre('');
    el('nombre-inicial').value = '';
    openNombreGate();
  });
  startPoll();
  refreshPedido();
  showView('home');
}

function initNombreGate() {
  el('btn-nombre-ok').addEventListener('click', () => {
    const n = el('nombre-inicial').value.trim();
    const err = el('nombre-gate-error');
    if (!n) {
      err.textContent = 'Escribí tu nombre.';
      return;
    }
    err.textContent = '';
    setNombre(n);
    closeNombreGate();
  });
  el('nombre-inicial').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') el('btn-nombre-ok').click();
  });
}

function readRemitoHistorial() {
  try {
    const raw = localStorage.getItem(LS_REMITO_HISTORIAL);
    if (!raw) return [];
    const a = JSON.parse(raw);
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

function writeRemitoHistorial(entries) {
  const trimmed = entries.slice(0, REMITO_HISTORIAL_MAX);
  localStorage.setItem(LS_REMITO_HISTORIAL, JSON.stringify(trimmed));
}

/** Añade una copia al historial (más reciente primero). Máx. REMITO_HISTORIAL_MAX; se descarta la más antigua. */
function pushRemitoHistorial(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, count: readRemitoHistorial().length };
  const next = [{ savedAt: Date.now(), text: t }, ...readRemitoHistorial()];
  writeRemitoHistorial(next);
  return { ok: true, count: readRemitoHistorial().length };
}

function saveRemitoLocal() {
  localStorage.setItem(LS_REMITO, el('remito-text').value);
}

function copyPedidoToRemito() {
  if (!itemsToday.length) {
    alert('No hay ítems en el pedido de hoy.');
    return;
  }
  const lines = itemsToday.map((it) => {
    const q = lineQty(it);
    const qStr = q > 1 ? ` x${q}` : '';
    return `- ${it.producto}${qStr} | ${it.proveedor} | ${it.estado}${it.donde ? ' | ' + it.donde : ''}`;
  });
  el('remito-text').value = `Distribuidora Rosendo — ${fecha()}\n\n${lines.join('\n')}\n`;
  saveRemitoLocal();
}

function printRemito() {
  saveRemitoLocal();
  const t = el('remito-text').value;
  const w = window.open('', '_blank');
  if (!w) {
    alert('Permití ventanas emergentes para imprimir.');
    return;
  }
  const pre = w.document.createElement('pre');
  pre.style.whiteSpace = 'pre-wrap';
  pre.style.fontFamily = 'system-ui, sans-serif';
  pre.style.padding = '1rem';
  pre.textContent = t || '(vacío)';
  w.document.body.appendChild(pre);
  w.document.title = 'Remito';
  w.print();
  w.close();
}

el('q').addEventListener('input', () => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(renderSearchResults, 180);
});

el('q-productos').addEventListener('input', () => {
  clearTimeout(debounceProductos);
  debounceProductos = setTimeout(renderProductos, 200);
});

el('q-proveedores').addEventListener('input', () => {
  clearTimeout(debounceProveedores);
  debounceProveedores = setTimeout(renderProveedores, 200);
});

let pendingAdd = null;

function openQtyModal(p) {
  pendingAdd = { nombre: p.nombre, proveedor: String(p.proveedor || '').trim() || '—' };
  const sug = unidadesDesdeNombre(p.nombre);
  el('qty-modal-title').textContent = p.nombre;
  el('qty-input').value = String(Math.max(1, Math.min(999, sug)));
  el('qty-modal-hint').textContent =
    sug > 1
      ? `Sugerido según el catálogo: ${sug} unidades por bulto (podés cambiar).`
      : 'Cantidad de bultos o unidades a pedir.';
  el('qty-modal').hidden = false;
  queueMicrotask(() => el('qty-input').focus());
}

function closeQtyModal() {
  el('qty-modal').hidden = true;
  pendingAdd = null;
}

function handleAddCatalogClick(e) {
  const btn = e.target.closest('.btn-add-catalog');
  if (!btn) return;
  const row = btn.closest('[data-id]');
  if (!row || !row.dataset.id) return;
  const id = row.dataset.id;
  const p = catalog.find((x) => x.id === id);
  if (!p) return;
  openQtyModal(p);
}

el('search-results').addEventListener('click', handleAddCatalogClick);
el('productos-list').addEventListener('click', (e) => {
  if (e.target.closest('.btn-add-catalog')) return;
  const tap = e.target.closest('.catalog-row-tap');
  if (!tap) return;
  const row = tap.closest('.catalog-prod-row');
  const id = row?.dataset?.id;
  if (id) openProductEdit(id);
});
el('productos-list').addEventListener('click', handleAddCatalogClick);
el('proveedores-mount').addEventListener('click', handleAddCatalogClick);

el('form-producto-edit').addEventListener('submit', saveProductCatalogFromForm);
el('fab-nuevo-producto').addEventListener('click', () => openNewProduct());

el('qty-confirm').addEventListener('click', async () => {
  const n = parseInt(el('qty-input').value, 10);
  if (Number.isNaN(n) || n < 1 || n > 999) {
    alert('Cantidad entre 1 y 999.');
    return;
  }
  const job = pendingAdd;
  closeQtyModal();
  if (!job) return;
  try {
    await agregarCatalogo(job.nombre, job.proveedor, n);
  } catch (err) {
    alert(err.message || String(err));
  }
});

el('qty-cancel').addEventListener('click', () => closeQtyModal());
el('qty-modal-backdrop').addEventListener('click', () => closeQtyModal());

el('qty-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') el('qty-confirm').click();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && el('qty-modal') && !el('qty-modal').hidden) closeQtyModal();
});

el('btn-ver-pedido-nuevo').addEventListener('click', () => showView('lista'));

el('btn-resumen-share-pdf').addEventListener('click', () => resumenShareOrDownloadPdf());
el('btn-resumen-print').addEventListener('click', () => openResumenPrintWindow());
el('btn-resumen-csv').addEventListener('click', () => resumenDownloadCsv());
el('btn-resumen-copy').addEventListener('click', () => resumenCopyText());
el('btn-resumen-share-text').addEventListener('click', () => resumenShareText());

el('btn-limpiar-lista').addEventListener('click', async () => {
  if (!itemsToday.length) return;
  if (!confirm('¿Vaciar todo el pedido de hoy? Esta acción no se puede deshacer.')) return;
  const copy = [...itemsToday];
  for (const it of copy) {
    await apiDeletePedido(it.id);
  }
  await refreshPedido();
});

el('lista-mount').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = b.closest('.lista-item').dataset.id;
  onListaAction(b.dataset.act, id);
});

el('btn-menu').addEventListener('click', () => {
  el('shell').classList.toggle('nav-open');
});

el('sidebar-backdrop').addEventListener('click', closeSidebar);

el('btn-back').addEventListener('click', () => {
  if (!el('view-producto-edit').hidden) {
    showView('productos');
    return;
  }
  showView('home');
});

el('nav-home').addEventListener('click', () => showView('home'));
el('nav-nuevo').addEventListener('click', () => {
  showView('buscar', { buscarNav: 'nuevo' });
  queueMicrotask(() => el('q').focus());
});
el('nav-buscar').addEventListener('click', () => {
  showView('buscar', { buscarNav: 'buscar' });
  queueMicrotask(() => el('q').focus());
});
el('nav-productos').addEventListener('click', () => showView('productos'));
el('nav-proveedores').addEventListener('click', () => showView('proveedores'));
el('nav-lista').addEventListener('click', () => showView('lista'));
el('nav-resumen').addEventListener('click', () => showView('resumen'));
el('nav-remito').addEventListener('click', () => showView('remito'));

el('go-lista').addEventListener('click', () => showView('lista'));
el('go-resumen').addEventListener('click', () => showView('resumen'));
el('go-remito').addEventListener('click', () => showView('remito'));
el('btn-remito-guardar').addEventListener('click', () => {
  const r = pushRemitoHistorial(el('remito-text').value);
  if (!r.ok) {
    alert('El remito está vacío; no hay nada que guardar en el historial.');
    return;
  }
  saveRemitoLocal();
  alert(`Guardado en este navegador: ${r.count}/${REMITO_HISTORIAL_MAX} remitos (el más antiguo se borra al pasar el límite).`);
});
el('btn-remito-print').addEventListener('click', printRemito);
el('btn-remito-desde-pedido').addEventListener('click', copyPedidoToRemito);

el('btn-focus-buscar').addEventListener('click', () => {
  showView('buscar', { buscarNav: 'nuevo' });
  queueMicrotask(() => el('q').focus());
});

async function boot() {
  initNombreGate();
  try {
    await loadCatalog();
  } catch (e) {
    el('setup-banner').hidden = false;
    el('setup-banner').textContent = 'Catálogo: ' + (e.message || String(e));
  }
  if (getNombre()) {
    closeNombreGate();
  } else {
    showView('home');
  }
}

boot();
