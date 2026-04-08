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

/** Fecha y hora local para impresión/PDF: `2026-04-08 20:42` */
function resumenFechaHoraImpresion() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${y}-${m}-${day} ${hh}:${mm}`;
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

function openNewProduct(opts = {}) {
  el('pe-id').value = '';
  el('pe-nombre').value = '';
  el('pe-proveedor').value = '';
  el('pe-pasillo').value = '';
  el('pe-marca').value = '';
  el('pe-categoria').value = '';
  showView('producto-edit', { isNew: true, focusProveedor: !!opts.focusProveedor });
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
    if (opts.focusProveedor) {
      queueMicrotask(() => el('pe-proveedor').focus());
    }
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
  }
  closeSidebar();
}

function renderLista() {
  const mount = el('lista-mount');
  const btnLimpiar = el('btn-limpiar-lista');
  const btnRes = el('btn-lista-a-resumen');
  if (itemsToday.length === 0) {
    mount.innerHTML =
      '<p class="empty-msg">No hay ítems hoy. Usá <strong>Buscar productos</strong> o <strong>Nuevo pedido</strong> en el menú para agregar.</p>';
    if (btnLimpiar) btnLimpiar.hidden = true;
    if (btnRes) btnRes.hidden = true;
    return;
  }
  if (btnLimpiar) btnLimpiar.hidden = false;
  if (btnRes) btnRes.hidden = false;
  const sorted = [...itemsToday].sort((a, b) =>
    (a.proveedor || '').localeCompare(b.proveedor || '', 'es')
  );
  mount.innerHTML = sorted
    .map((item) => {
      const donde = item.donde ? `<div class="lista-donde">📍 ${escapeHtml(item.donde)}</div>` : '';
      const q = lineQty(item);
      return `<div class="lista-item lista-item-sheet" data-id="${item.id}">
        <div class="lista-sheet-row">
          <div class="lista-sheet-main">
            <div class="lista-prod-name">${escapeHtml(item.producto)}</div>
            <div class="lista-prod-meta">${escapeHtml(item.proveedor)} · ${q} un.</div>
            ${donde}
            <div class="lista-quien-hint">Último: ${escapeHtml(item.quien || '—')} · Estado en <strong>Resumen por proveedor</strong></div>
          </div>
          <div class="lista-sheet-ic">
            <span class="lista-qty-big" aria-hidden="true">${q}</span>
            <button type="button" class="lista-ic-btn" data-act="editar-cant" aria-label="Editar cantidad">✎</button>
            <button type="button" class="lista-ic-btn lista-ic-danger" data-act="eliminar" aria-label="Eliminar">🗑</button>
          </div>
        </div>
      </div>`;
    })
    .join('');
}

/** @returns {null | { sections: { proveedor: string, pasillos: { label: string, items: Record<string, unknown>[] }[] }[] }} */
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
        .map((r) => ({ ...r, qty: lineQty(r) })),
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

function resumenEstadoBadge(it) {
  const badge =
    it.estado === 'pendiente'
      ? 'pendiente'
      : it.estado === 'comprado'
        ? 'comprado'
        : 'conseguido';
  const label =
    it.estado === 'pendiente'
      ? 'Pendiente'
      : it.estado === 'comprado'
        ? 'Comprado'
        : 'Conseguido';
  return { badge, label };
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
        const { badge, label } = resumenEstadoBadge(it);
        const donde = it.donde ? `<div class="resumen-donde">📍 ${escapeHtml(it.donde)}</div>` : '';
        html += `<div class="lista-item resumen-item-card" data-id="${String(it.id).replace(/"/g, '')}">
          <div class="resumen-item-head">
            <div class="resumen-item-text">
              <div class="lista-prod-name">${escapeHtml(it.producto)}</div>
              <div class="lista-prod-meta">${it.qty} un.</div>
              ${donde}
            </div>
            <span class="badge ${badge}">${label}</span>
          </div>
          <div class="lista-actions lista-actions-compact resumen-item-actions">
            <button type="button" class="btn-sm" data-act="pendiente">Pendiente</button>
            <button type="button" class="btn-sm primary" data-act="comprado">Compré</button>
            <button type="button" class="btn-sm accent" data-act="conseguido">Conseguí en…</button>
            <button type="button" class="btn-sm danger" data-act="eliminar">Eliminar</button>
          </div>
        </div>`;
      }
    }
    html += '</section>';
  }
  mount.innerHTML = html;
}

function buildResumenPrintDocumentHtml(tree) {
  const fechaHora = resumenFechaHoraImpresion();
  const n = tree.sections.length;
  let body = '';
  tree.sections.forEach((sec, i) => {
    const last = i === n - 1;
    body += `<section class="print-prov${last ? ' print-prov-last' : ''}">`;
    body += `<h1 class="print-doc-title">Repaso depósito ${escapeHtml(sec.proveedor)}</h1>`;
    body += `<p class="print-fecha">Fecha: ${escapeHtml(fechaHora)}</p>`;
    body +=
      '<table class="print-grid"><thead><tr>' +
      '<th>MAYORISTA</th><th>Pasillo</th><th>Productos</th><th>Cantidad</th>' +
      '</tr></thead><tbody>';
    for (const block of sec.pasillos) {
      for (const it of block.items) {
        body += `<tr><td>${escapeHtml(sec.proveedor)}</td><td>${escapeHtml(block.label)}</td><td>${escapeHtml(it.producto)}</td><td class="print-qty">${escapeHtml(String(it.qty))}</td></tr>`;
      }
    }
    body += `</tbody><tfoot><tr><td colspan="4" class="print-page-idx">-- ${i + 1} of ${n} --</td></tr></tfoot></table></section>`;
  });
  return `<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"/><title>Repaso depósito — ${escapeHtml(fecha())}</title>
<style>
  *{box-sizing:border-box;}
  body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:10mm 12mm;font-size:10pt;color:#111;}
  .print-doc-title{font-size:14pt;font-weight:700;margin:0 0 2mm;text-transform:none;}
  .print-fecha{margin:0 0 5mm;font-size:10pt;}
  .print-grid{width:100%;border-collapse:collapse;table-layout:fixed;}
  .print-grid th,.print-grid td{border:1px solid #888;padding:3px 5px;vertical-align:top;word-wrap:break-word;}
  .print-grid th{background:#e8e8e8;font-size:9pt;font-weight:700;text-align:left;}
  .print-grid td{font-size:9pt;}
  .print-grid th:nth-child(1),.print-grid td:nth-child(1){width:18%;}
  .print-grid th:nth-child(2),.print-grid td:nth-child(2){width:16%;}
  .print-grid th:nth-child(3),.print-grid td:nth-child(3){width:54%;}
  .print-grid th:nth-child(4),.print-grid td:nth-child(4){width:12%;}
  .print-qty{text-align:center;font-weight:600;}
  .print-grid tfoot td{border:none;padding-top:6mm;font-size:9pt;color:#333;}
  .print-page-idx{text-align:center;}
  @media print{
    thead{display:table-header-group;}
    tfoot{display:table-footer-group;}
  }
  .print-prov{page-break-after:always;}
  .print-prov-last{page-break-after:auto;}
</style></head><body>
${body}
</body></html>`;
}

function openResumenPrintWindow() {
  const tree = computeResumenTree();
  if (!tree) {
    alert('No hay datos en el resumen.');
    return;
  }
  const html = buildResumenPrintDocumentHtml(tree);
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

function pdfStampRepasoFooter(doc, supplierIndex1Based, totalSuppliers) {
  const w = doc.internal.pageSize.getWidth();
  const h = doc.internal.pageSize.getHeight();
  doc.setFontSize(9);
  doc.setTextColor(55);
  doc.text(`-- ${supplierIndex1Based} of ${totalSuppliers} --`, w / 2, h - 10, { align: 'center' });
  doc.setTextColor(0);
}

async function resumenShareOrDownloadPdf() {
  const tree = computeResumenTree();
  if (!tree) {
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
    const margin = 14;
    const rightEdge = doc.internal.pageSize.getWidth() - margin;
    const colMay = margin;
    const colMayW = 30;
    const colPas = colMay + colMayW + 2;
    const colPasW = 26;
    const colProd = colPas + colPasW + 2;
    const colProdW = 100;
    const lh = 3.8;
    const yMaxContent = 272;
    const nSec = tree.sections.length;
    const fechaHoraPdf = resumenFechaHoraImpresion();

    const drawTableHeader = (y0) => {
      let y = y0;
      doc.setFontSize(9);
      doc.setFont('helvetica', 'bold');
      doc.text('MAYORISTA', colMay, y);
      doc.text('Pasillo', colPas, y);
      doc.text('Productos', colProd, y);
      doc.text('Cantidad', rightEdge, y, { align: 'right' });
      doc.setFont('helvetica', 'normal');
      y += lh + 0.5;
      doc.setDrawColor(130);
      doc.line(margin, y, rightEdge, y);
      return y + 2.5;
    };

    const rowBlockHeight = (may, pas, prod) => {
      doc.setFontSize(9);
      doc.setFont('helvetica', 'normal');
      const lm = doc.splitTextToSize(may, colMayW);
      const lp = doc.splitTextToSize(pas, colPasW);
      const lr = doc.splitTextToSize(prod, colProdW);
      const lines = Math.max(lm.length, lp.length, lr.length, 1);
      return lines * lh + 1;
    };

    const drawDataRow = (y0, may, pas, prod, qty) => {
      const lm = doc.splitTextToSize(may, colMayW);
      const lp = doc.splitTextToSize(pas, colPasW);
      const lr = doc.splitTextToSize(prod, colProdW);
      const n = Math.max(lm.length, lp.length, lr.length, 1);
      let y = y0;
      for (let i = 0; i < n; i++) {
        doc.setFontSize(9);
        doc.setFont('helvetica', 'normal');
        doc.text(lm[i] || '', colMay, y);
        doc.text(lp[i] || '', colPas, y);
        doc.text(lr[i] || '', colProd, y);
        if (i === 0) doc.text(String(qty), rightEdge, y, { align: 'right' });
        y += lh;
      }
      return y + 1;
    };

    for (let si = 0; si < nSec; si++) {
      const sec = tree.sections[si];
      if (si > 0) doc.addPage();
      let y = 12;
      doc.setFontSize(13);
      doc.setFont('helvetica', 'bold');
      doc.text(`Repaso depósito ${sec.proveedor}`, margin, y);
      doc.setFont('helvetica', 'normal');
      y += 7;
      doc.setFontSize(10);
      doc.text(`Fecha: ${fechaHoraPdf}`, margin, y);
      y += 8;
      y = drawTableHeader(y);

      for (const block of sec.pasillos) {
        for (const it of block.items) {
          const may = String(sec.proveedor || '');
          const pas = String(block.label || '');
          const prod = String(it.producto || '');
          const qty = it.qty;
          const need = rowBlockHeight(may, pas, prod);
          if (y + need > yMaxContent) {
            pdfStampRepasoFooter(doc, si + 1, nSec);
            doc.addPage();
            y = 12;
            y = drawTableHeader(y);
          }
          y = drawDataRow(y, may, pas, prod, qty);
        }
      }
      pdfStampRepasoFooter(doc, si + 1, nSec);
    }
    blob = doc.output('blob');
  } catch (e) {
    console.warn('PDF:', e);
  }
  const name = `repaso_deposito_${fecha()}.pdf`;
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

function getQtyInputValue() {
  const n = parseInt(String(el('qty-input').value).trim(), 10);
  if (Number.isNaN(n)) return 1;
  return Math.max(1, Math.min(999, n));
}

function qtyInputIsEmpty() {
  return String(el('qty-input').value).trim() === '';
}

function setQtyInputValue(n) {
  el('qty-input').value = String(Math.max(1, Math.min(999, n)));
}

function syncQtyStepperButtons() {
  if (qtyInputIsEmpty()) {
    el('qty-dec').disabled = true;
    el('qty-inc').disabled = false;
    return;
  }
  const v = getQtyInputValue();
  el('qty-dec').disabled = v <= 1;
  el('qty-inc').disabled = v >= 999;
}

function openQtyModal(p) {
  pendingAdd = { nombre: p.nombre, proveedor: String(p.proveedor || '').trim() || '—' };
  const sug = unidadesDesdeNombre(p.nombre);
  el('qty-modal-title').textContent = p.nombre;
  setQtyInputValue(1);
  syncQtyStepperButtons();
  el('qty-modal-hint').textContent =
    sug > 1
      ? `Usá + / − o tocá el número para escribir (ej. 20). Referencia catálogo: ${sug} u. por bulto.`
      : 'Usá + / − o tocá el número para escribir la cantidad.';
  el('qty-modal').hidden = false;
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
el('fab-nuevo-proveedor').addEventListener('click', () => openNewProduct({ focusProveedor: true }));

el('qty-dec').addEventListener('click', () => {
  if (qtyInputIsEmpty()) return;
  setQtyInputValue(getQtyInputValue() - 1);
  syncQtyStepperButtons();
});

el('qty-inc').addEventListener('click', () => {
  if (qtyInputIsEmpty()) setQtyInputValue(1);
  else setQtyInputValue(getQtyInputValue() + 1);
  syncQtyStepperButtons();
});

el('qty-input').addEventListener('input', () => {
  syncQtyStepperButtons();
});

el('qty-input').addEventListener('blur', () => {
  setQtyInputValue(getQtyInputValue());
  syncQtyStepperButtons();
});

el('qty-confirm').addEventListener('click', async () => {
  if (qtyInputIsEmpty()) {
    alert('Escribí una cantidad o usá + / −.');
    return;
  }
  const n = getQtyInputValue();
  if (n < 1 || n > 999) {
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

el('resumen-mount').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const row = b.closest('.lista-item');
  if (!row?.dataset?.id) return;
  onListaAction(b.dataset.act, row.dataset.id);
});

el('btn-lista-a-resumen').addEventListener('click', () => showView('resumen'));

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

el('go-lista').addEventListener('click', () => showView('lista'));
el('go-resumen').addEventListener('click', () => showView('resumen'));

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
