/**
 * Tibia · API de la hoja de Google Sheets
 * -------------------------------------------------------------
 * Este script vive dentro de la hoja «Tibia · Panel de la galletería».
 * - doGet  → entrega a la web la configuración, los productos visibles,
 *            las fechas cerradas, los cupos ocupados y la votación.
 * - doPost → registra pedidos (pestañas Pedidos y Detalle) y votos.
 * - configurarTibia → se ejecuta UNA vez: zona horaria, listas
 *   desplegables, fórmulas de Producción y conteo de votos.
 *
 * Instalación: ver README.md del repositorio (sección «Hoja y Apps Script»).
 */

const TZ_DEFAULT = 'America/Bogota';
const ESTADOS = ['Por confirmar', 'Confirmado', 'Horneado', 'En camino', 'Entregado', 'Cancelado', 'Revisar'];
const DIAS = { domingo: 0, lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5, sabado: 6 };

/* ---------- utilidades ---------- */
function ss_() { return SpreadsheetApp.getActive(); }
function tz_() { return ss_().getSpreadsheetTimeZone() || TZ_DEFAULT; }
function sheet_(name) { return ss_().getSheetByName(name); }
function sinTildes_(s) { return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function si_(v) { return sinTildes_(v) === 'si'; }
function num_(v, d) { const n = Number(String(v).replace(/[^\d.-]/g, '')); return isFinite(n) && String(v).trim() !== '' ? n : d; }
function ymd_(d) { return Utilities.formatDate(d, tz_(), 'yyyy-MM-dd'); }
function json_(obj) { return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON); }
function rows_(name) {
  const sh = sheet_(name); if (!sh) return [];
  const v = sh.getDataRange().getValues(); const head = v.shift() || [];
  return v.filter(r => r.some(c => c !== '' && c !== null)).map(r => { const o = {}; head.forEach((h, i) => o[h] = r[i]); return o; });
}

function leerConfig_() {
  const c = {};
  rows_('Configuración').forEach(r => { c[sinTildes_(r['Ajuste'])] = r['Valor']; });
  const dias = String(c['dias de hornada'] || 'lunes, miercoles, viernes').split(/[,;y]+/)
    .map(s => DIAS[sinTildes_(s)]).filter(n => n !== undefined);
  return {
    abierta: c['tienda abierta'] === undefined ? true : si_(c['tienda abierta']),
    dias: dias.length ? dias : [1, 3, 5],
    horaHorneado: num_(c['hora de horneado'], 16),
    horaCorte: num_(c['hora de corte'], 14),
    cupo: num_(c['cupo por hornada'], 30),
    bandeja: num_(c['galletas por bandeja'], 15),
    whatsapp: String(c['whatsapp del negocio'] || '').replace(/\D/g, ''),
    precioUnidad: num_(c['precio por unidad'], 5000),
    caja4: num_(c['precio caja de 4'], 18000),
    caja6: num_(c['precio caja de 6'], 26000),
    recargo: num_(c['recargo por galleta rellena'], 1500),
    franjas: String(c['franjas de entrega'] || '').split(';').map(s => s.trim()).filter(Boolean),
    votacion: {
      activa: c['votacion activa'] === undefined ? true : si_(c['votacion activa']),
      pregunta: String(c['pregunta de la votacion'] || ''),
      cierre: String(c['cierre de la votacion'] || '')
    }
  };
}

function leerProductos_(soloVisibles) {
  return rows_('Productos')
    .filter(r => r['ID'] && (!soloVisibles || si_(r['Visible'])))
    .sort((a, b) => num_(a['Orden'], 99) - num_(b['Orden'], 99))
    .map(r => ({
      id: String(r['ID']).trim(), nombre: String(r['Nombre']), descripcion: String(r['Descripción'] || ''),
      etiqueta: String(r['Etiqueta'] || ''), rellena: si_(r['Rellena']), masa: String(r['Masa'] || ''),
      colorMasa: String(r['Color masa'] || '#D9A262'), colorBorde: String(r['Color borde'] || '#B6804A'),
      chips: String(r['Colores chips'] || '').split(',').map(s => s.trim()).filter(Boolean),
      adorno: sinTildes_(r['Adorno'] || ''), colorRelleno: String(r['Color relleno'] || '')
    }));
}

function fechasCerradas_() {
  return rows_('Fechas cerradas').map(r => r['Fecha'])
    .filter(f => f instanceof Date || /^\d{4}-\d{2}-\d{2}$/.test(String(f)))
    .map(f => f instanceof Date ? ymd_(f) : String(f));
}

/** Galletas ya comprometidas por hornada (excluye pedidos cancelados). */
function ocupado_() {
  const out = {}; const hoy = ymd_(new Date());
  rows_('Pedidos').forEach(r => {
    if (r['Estado'] === 'Cancelado') return;
    const h = r['Hornada'] instanceof Date ? ymd_(r['Hornada']) : String(r['Hornada']);
    if (!h || h < hoy) return;
    out[h] = (out[h] || 0) + num_(r['Galletas'], 0);
  });
  return out;
}

function votacion_() {
  const conteo = {};
  rows_('Votos').forEach(r => { const s = String(r['Sabor']); conteo[s] = (conteo[s] || 0) + 1; });
  return rows_('Votación').filter(r => r['ID'] && si_(r['Visible'])).map(r => ({
    id: String(r['ID']).trim(), nombre: String(r['Nombre']), descripcion: String(r['Descripción'] || ''),
    colorMasa: String(r['Color masa'] || '#D9A262'), colorBorde: String(r['Color borde'] || '#B6804A'),
    chips: String(r['Colores chips'] || '').split(',').map(s => s.trim()).filter(Boolean),
    votos: conteo[String(r['ID']).trim()] || 0
  }));
}

/* ---------- seguridad ----------
 * La web nunca llama a este script directamente: pasa por la función /api de
 * Cloudflare, que agrega la clave (API_KEY) y valida la sesión del dueño.
 * Mientras la propiedad API_KEY no exista, el script acepta llamadas sin clave. */
function claveValida_(e) {
  const key = PropertiesService.getScriptProperties().getProperty('API_KEY');
  return !key || (e && e.parameter && e.parameter.key === key);
}
/** Ejecutar una vez desde el editor: crea la clave y la muestra en el registro. */
function generarClave() {
  const props = PropertiesService.getScriptProperties();
  let key = props.getProperty('API_KEY');
  if (!key) { key = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''); props.setProperty('API_KEY', key); }
  Logger.log('API_KEY (cópiala en Cloudflare como APPS_SCRIPT_KEY): ' + key);
}

/* ---------- lectura para la web ---------- */
function doGet(e) {
  if (!claveValida_(e)) return json_({ ok: false, error: 'No autorizado' });
  const cfg = leerConfig_();
  const resp = {
    ok: true, ahora: new Date().toISOString(), config: cfg,
    productos: leerProductos_(true), cerradas: fechasCerradas_(), ocupado: ocupado_(),
    votacion: Object.assign({}, cfg.votacion, { candidatos: cfg.votacion.activa ? votacion_() : [] })
  };
  return json_(resp);
}

/* ---------- registro de pedidos, votos y acciones del dueño ---------- */
function doPost(e) {
  if (!claveValida_(e)) return json_({ ok: false, error: 'No autorizado' });
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'Formato inválido' }); }
  if (d.trampa) return json_({ ok: true }); // campo oculto anti-spam
  const p = (e && e.parameter) || {};
  const esAdmin = p.admin === '1' && !!PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (String(d.tipo || '').indexOf('admin_') === 0) {
    if (!esAdmin) return json_({ ok: false, error: 'No autorizado' });
    if (d.tipo === 'admin_resumen') return json_(adminResumen_());
  }
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (d.tipo === 'voto') return json_(registrarVoto_(d));
    if (d.tipo === 'pedido') { d.sinVerificar = p.v === '0'; return json_(registrarPedido_(d)); }
    if (d.tipo === 'admin_estado') return json_(adminEstado_(d));
    if (d.tipo === 'admin_producto') return json_(adminProducto_(d));
    if (d.tipo === 'admin_config') return json_(adminConfig_(d));
    if (d.tipo === 'admin_fecha') return json_(adminFecha_(d));
    return json_({ ok: false, error: 'Tipo desconocido' });
  } finally { lock.releaseLock(); }
}

function registrarVoto_(d) {
  const sabor = String(d.sabor || '').slice(0, 40), disp = String(d.dispositivo || '').slice(0, 60);
  if (!sabor || !votacion_().some(c => c.id === sabor)) return { ok: false, error: 'Sabor no válido' };
  const sh = sheet_('Votos');
  if (disp && rows_('Votos').some(r => String(r['Dispositivo']) === disp)) return { ok: true, repetido: true };
  sh.appendRow([new Date(), sabor, disp]);
  return { ok: true };
}

function registrarPedido_(d) {
  const cfg = leerConfig_();
  const prods = {}; leerProductos_(false).forEach(p => prods[p.id] = p);
  const cajas = { x4: { n: 4, precio: cfg.caja4, nombre: 'Caja de 4' }, x6: { n: 6, precio: cfg.caja6, nombre: 'Caja de 6' }, unidad: { n: 0, precio: 0, nombre: 'Unidad' } };

  // Recalcula todo en el servidor: la web no decide el precio.
  const items = Array.isArray(d.items) ? d.items.slice(0, 10) : [];
  let galletas = 0, total = 0; const sabores = {}; const detalle = [];
  for (const it of items) {
    const caja = cajas[it.tipo]; if (!caja) return { ok: false, error: 'Presentación no válida' };
    let n = 0, recargo = 0; const partes = [];
    Object.keys(it.sabores || {}).forEach(id => {
      const q = Math.max(0, Math.floor(num_(it.sabores[id], 0))); const p = prods[id];
      if (!q || !p) return;
      n += q; if (p.rellena) recargo += q * cfg.recargo;
      sabores[id] = (sabores[id] || 0) + q; partes.push(q + ' ' + p.nombre);
    });
    if (!n) continue;
    if (caja.n && n !== caja.n) return { ok: false, error: 'La caja no está completa' };
    const precio = (caja.n ? caja.precio : n * cfg.precioUnidad) + recargo;
    galletas += n; total += precio; detalle.push(caja.nombre + ': ' + partes.join(', '));
  }
  if (!galletas) return { ok: false, error: 'Pedido vacío' };

  // Hornada: debe ser un día de horneado, no cerrado y antes del corte.
  const hornada = String(d.hornada || '');
  let estado = 'Por confirmar', nota = '';
  const m = hornada.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return { ok: false, error: 'Hornada no válida' };
  const fecha = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const corte = Utilities.parseDate(hornada + ' ' + String(cfg.horaCorte).padStart(2, '0') + ':00', tz_(), 'yyyy-MM-dd HH:mm');
  if (cfg.dias.indexOf(fecha.getDay()) < 0 || fechasCerradas_().indexOf(hornada) >= 0 || new Date() > corte || !cfg.abierta) { estado = 'Revisar'; nota = 'fuera de horario o día cerrado'; }
  const ocupadas = ocupado_()[hornada] || 0;
  if (ocupadas + galletas > cfg.cupo) { estado = 'Revisar'; nota = 'supera el cupo (' + (ocupadas + galletas) + '/' + cfg.cupo + ')'; }
  if (d.sinVerificar) { estado = 'Revisar'; nota = (nota ? nota + '; ' : '') + 'no pasó la verificación anti-bots'; }

  const codigo = String(d.codigo || '').replace(/[^\w-]/g, '').slice(0, 12) || ('TIB-' + Date.now().toString().slice(-4));
  const limpio = s => String(s || '').replace(/^[=+\-@]/, "'$&").slice(0, 200); // evita fórmulas inyectadas
  sheet_('Pedidos').appendRow([
    new Date(), codigo, fecha, limpio(d.nombre), limpio(d.direccion), limpio(d.franja),
    d.pago === 'antes' ? 'Antes' : 'Al recibir', limpio(d.medio), limpio(d.pagaCon),
    galletas, detalle.join(' · ') + (nota ? '  [' + nota + ']' : ''), total, estado, d.autoriza ? 'Sí' : 'No'
  ]);
  const det = sheet_('Detalle'); const start = det.getLastRow() + 1;
  const filas = Object.keys(sabores).map((id, i) => [codigo, fecha, prods[id].nombre, sabores[id],
    '=IFERROR(INDEX(Pedidos!M:M,MATCH(A' + (start + i) + ',Pedidos!B:B,0)),"")']);
  if (filas.length) det.getRange(start, 1, filas.length, 5).setValues(filas);
  return { ok: true, codigo: codigo, total: total, estado: estado };
}

/* ---------- panel del dueño ---------- */
function proximasHornadas_(cfg, n) {
  const out = [], cerradas = fechasCerradas_(), hoy = new Date();
  const base = new Date(hoy.getFullYear(), hoy.getMonth(), hoy.getDate());
  for (let i = 0; out.length < n && i < 35; i++) {
    const d = new Date(base); d.setDate(base.getDate() + i);
    const k = ymd_(d);
    if (cfg.dias.indexOf(d.getDay()) >= 0 && cerradas.indexOf(k) < 0) out.push(k);
  }
  return out;
}

function adminResumen_() {
  const cfg = leerConfig_(), tz = tz_();
  const prods = leerProductos_(false);
  const desde = ymd_(new Date(Date.now() - 3 * 864e5));
  const pedidos = [];
  rows_('Pedidos').forEach(r => {
    const h = r['Hornada'] instanceof Date ? ymd_(r['Hornada']) : String(r['Hornada'] || '');
    if (!h || h < desde) return;
    pedidos.push({
      codigo: String(r['Código']), registrado: r['Registrado'] instanceof Date ? Utilities.formatDate(r['Registrado'], tz, "yyyy-MM-dd'T'HH:mm") : '',
      hornada: h, nombre: String(r['Recibe'] || ''), direccion: String(r['Dirección'] || ''), franja: String(r['Franja'] || ''),
      pago: String(r['Pago'] || ''), medio: String(r['Medio'] || ''), pagaCon: String(r['Paga con'] || ''),
      galletas: num_(r['Galletas'], 0), detalle: String(r['Detalle'] || ''), total: num_(r['Total'], 0), estado: String(r['Estado'] || 'Por confirmar')
    });
  });
  const estadoDe = {}; pedidos.forEach(p => estadoDe[p.codigo] = p.estado);
  const produccion = {};
  rows_('Detalle').forEach(r => {
    const h = r['Hornada'] instanceof Date ? ymd_(r['Hornada']) : String(r['Hornada'] || '');
    const c = String(r['Código']);
    if (!h || h < desde || !(c in estadoDe) || estadoDe[c] === 'Cancelado') return;
    produccion[h] = produccion[h] || {};
    produccion[h][r['Sabor']] = (produccion[h][r['Sabor']] || 0) + num_(r['Cantidad'], 0);
  });
  const hoy = ymd_(new Date());
  const hornadas = proximasHornadas_(cfg, 4);
  Object.keys(produccion).forEach(h => { if (h >= hoy && hornadas.indexOf(h) < 0) hornadas.push(h); });
  hornadas.sort();
  return {
    ok: true, ahora: new Date().toISOString(), hoy: hoy, config: cfg, hornadas: hornadas,
    productos: rows_('Productos').filter(r => r['ID']).map(r => ({
      id: String(r['ID']).trim(), nombre: String(r['Nombre']), visible: si_(r['Visible']), masa: String(r['Masa'] || ''),
      colorMasa: String(r['Color masa'] || ''), colorBorde: String(r['Color borde'] || ''),
      chips: String(r['Colores chips'] || '').split(',').map(x => x.trim()).filter(Boolean),
      adorno: sinTildes_(r['Adorno'] || ''), rellena: si_(r['Rellena']), colorRelleno: String(r['Color relleno'] || ''), orden: num_(r['Orden'], 99)
    })).sort((a, b) => a.orden - b.orden),
    cerradas: rows_('Fechas cerradas').filter(r => r['Fecha']).map(r => ({ fecha: r['Fecha'] instanceof Date ? ymd_(r['Fecha']) : String(r['Fecha']), motivo: String(r['Motivo'] || '') })),
    pedidos: pedidos, produccion: produccion, votacion: votacion_(),
    hoja: ss_().getUrl()
  };
}

function filaPor_(nombreHoja, col, valor) {
  const sh = sheet_(nombreHoja), v = sh.getRange(1, col, sh.getLastRow(), 1).getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]).trim() === String(valor)) return i + 1;
  return 0;
}

function adminEstado_(d) {
  if (ESTADOS.indexOf(d.estado) < 0) return { ok: false, error: 'Estado no válido' };
  const f = filaPor_('Pedidos', 2, d.codigo); if (!f) return { ok: false, error: 'Pedido no encontrado' };
  sheet_('Pedidos').getRange(f, 13).setValue(d.estado);
  return { ok: true };
}

function adminProducto_(d) {
  const f = filaPor_('Productos', 3, d.id); if (!f) return { ok: false, error: 'Producto no encontrado' };
  sheet_('Productos').getRange(f, 1).setValue(d.visible ? 'Sí' : 'No');
  return { ok: true };
}

function adminConfig_(d) {
  const permitidos = { 'Tienda abierta': 'sino', 'Votación activa': 'sino', 'Cupo por hornada': 'num' };
  const tipo = permitidos[d.clave]; if (!tipo) return { ok: false, error: 'Ajuste no permitido' };
  const f = filaPor_('Configuración', 1, d.clave); if (!f) return { ok: false, error: 'Ajuste no encontrado' };
  let v = d.valor;
  if (tipo === 'sino') v = v ? 'Sí' : 'No';
  if (tipo === 'num') { v = Math.floor(num_(v, -1)); if (v < 0 || v > 1000) return { ok: false, error: 'Número no válido' }; }
  sheet_('Configuración').getRange(f, 2).setValue(v);
  return { ok: true };
}

function adminFecha_(d) {
  const m = String(d.fecha || '').match(/^(\d{4})-(\d{2})-(\d{2})$/); if (!m) return { ok: false, error: 'Fecha no válida' };
  const sh = sheet_('Fechas cerradas'), v = sh.getDataRange().getValues();
  for (let i = v.length - 1; i >= 1; i--) {
    const k = v[i][0] instanceof Date ? ymd_(v[i][0]) : String(v[i][0]);
    if (k === d.fecha) { if (d.cerrar) return { ok: true }; sh.deleteRow(i + 1); }
  }
  if (d.cerrar) sh.appendRow([new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])), String(d.motivo || '').replace(/^[=+\-@]/, "'$&").slice(0, 80)]);
  return { ok: true };
}

/* ---------- configuración inicial (ejecutar una vez) ---------- */
function configurarTibia() {
  const ss = ss_();
  ss.setSpreadsheetTimeZone(TZ_DEFAULT);
  const siNo = SpreadsheetApp.newDataValidation().requireValueInList(['Sí', 'No'], true).build();
  const cfg = sheet_('Configuración');
  ['Tienda abierta', 'Votación activa'].forEach(k => {
    const f = cfg.getRange('A:A').getValues().findIndex(r => r[0] === k);
    if (f >= 0) cfg.getRange(f + 1, 2).setDataValidation(siNo);
  });
  sheet_('Productos').getRange('A2:A100').setDataValidation(siNo);
  sheet_('Productos').getRange('G2:G100').setDataValidation(siNo);
  sheet_('Votación').getRange('A2:A50').setDataValidation(siNo);
  sheet_('Votación').getRange('H2').setFormula('=ARRAYFORMULA(IF(B2:B="",,COUNTIF(Votos!B:B,B2:B)))');

  const ped = sheet_('Pedidos');
  ped.getRange('M2:M5000').setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(ESTADOS, true).build());
  ped.getRange('A2:A5000').setNumberFormat('dd/MM/yyyy HH:mm');
  ped.getRange('C2:C5000').setNumberFormat('ddd dd/MM');
  ped.getRange('L2:L5000').setNumberFormat('$#,##0');
  sheet_('Detalle').getRange('B2:B5000').setNumberFormat('ddd dd/MM');
  sheet_('Votos').getRange('A2:A5000').setNumberFormat('dd/MM/yyyy HH:mm');
  sheet_('Fechas cerradas').getRange('A2:A500').setNumberFormat('yyyy-mm-dd')
    .setDataValidation(SpreadsheetApp.newDataValidation().requireDate().build());

  // Formato condicional de estados en Pedidos
  const reglas = [['Por confirmar', '#FFEFD3'], ['Confirmado', '#E5EBF8'], ['Horneado', '#F5E7D3'], ['En camino', '#F5E7D3'], ['Entregado', '#E2F3E8'], ['Cancelado', '#EEEEEE'], ['Revisar', '#F9D6D3']]
    .map(([t, c]) => SpreadsheetApp.newConditionalFormatRule().whenTextEqualTo(t).setBackground(c).setRanges([ped.getRange('M2:M5000')]).build());
  ped.setConditionalFormatRules(reglas);

  // Producción: totales por hornada + desglose por sabor (se actualiza solo)
  const pr = sheet_('Producción'); pr.clear();
  const filtro = 'B is not null and E <> \'Cancelado\' and B >= date \'"&TEXT(TODAY(),"yyyy-mm-dd")&"\'';
  pr.getRange('A1').setValue('Producción de las próximas hornadas').setFontWeight('bold').setFontSize(14);
  pr.getRange('A2').setValue('Se actualiza sola con cada pedido. No incluye pedidos cancelados.').setFontColor('#7D6656');
  pr.getRange('A4').setFormula('=IFERROR(QUERY(Detalle!A1:E,"select B, sum(D) where ' + filtro + ' group by B order by B label B \'Hornada\', sum(D) \'Galletas\'",1),"Sin pedidos todavía")');
  pr.getRange('C4').setFormula('=ARRAYFORMULA(IF(ROW(A4:A60)=4,"Bandejas",IF(ISNUMBER(B4:B60),ROUNDUP(B4:B60/VALUE(INDEX(Configuración!B:B,MATCH("Galletas por bandeja",Configuración!A:A,0)))),"")))');
  pr.getRange('D4').setFormula('=ARRAYFORMULA(IF(ROW(A4:A60)=4,"Cupo libre",IF(ISNUMBER(B4:B60),VALUE(INDEX(Configuración!B:B,MATCH("Cupo por hornada",Configuración!A:A,0)))-B4:B60,"")))');
  pr.getRange('F4').setFormula('=IFERROR(QUERY(Detalle!A1:E,"select B, sum(D) where ' + filtro + ' group by B pivot C label B \'Hornada\'",1),"")');
  pr.getRange('A4:A60').setNumberFormat('ddd dd/MM'); pr.getRange('F4:F60').setNumberFormat('ddd dd/MM');
  pr.getRange('A4:Z4').setFontWeight('bold');
  pr.setColumnWidth(1, 110); pr.setColumnWidth(6, 110);

  [['Pedidos', 1], ['Detalle', 1], ['Votos', 1], ['Producción', 4]].forEach(([n, r]) => sheet_(n).setFrozenRows(r));
  ss.setActiveSheet(pr);
  SpreadsheetApp.getUi && Logger.log('Tibia configurada. Ahora publica: Implementar → Nueva implementación → Aplicación web.');
}
