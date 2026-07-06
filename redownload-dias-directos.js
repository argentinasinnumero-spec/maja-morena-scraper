'use strict';

/**
 * Re-descarga días específicos usando el endpoint ExportSalesHistory directamente
 * (no usa el filtro jQuery de la UI que falla intermitentemente).
 * Guarda en resumen_diario y reconstruye resumen_mensual.
 *
 * Uso: node redownload-dias-directos.js 2026-07-01 2026-07-02
 *      (pasar los fecha_iso = la fecha de FIN del día comercial)
 */

require('dotenv').config();
const path  = require('path');
const fs    = require('fs');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    }),
  });
}

let puppeteer; try { puppeteer = require('puppeteer'); } catch {}
let XLSX;     try { XLSX = require('xlsx'); }           catch {}

const db = admin.firestore();
const esperar = ms => new Promise(r => setTimeout(r, ms));

const DESCARGAS_DIR = path.join(__dirname, 'descargas_nucleo');
if (!fs.existsSync(DESCARGAS_DIR)) fs.mkdirSync(DESCARGAS_DIR, { recursive: true });

const NUCLEO_BASE  = 'https://nucleoit.com.ar';
const NUCLEO_LOGIN = `${NUCLEO_BASE}/Account/LogOn?ReturnUrl=%2fNG%2fClientesGastronomico%2fIndex`;

const LOCALES_MAP = {
  MAJAMORENA:      { nombre: 'Libertad',   ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'propio' },
  MAJASANMARTIN:   { nombre: 'San Martin', ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'propio' },
  MAJASANMARTIN58: { nombre: 'Express',    ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'propio' },
  MAJASARMIENTO:   { nombre: 'Sarmiento',  ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'propio' },
  MAJAMORENAWO:    { nombre: 'WO',         ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'propio' },
  MAJACOSQUIN:     { nombre: 'Cosquin',    ciudad: 'Cosquin',          zona: 'cosquin',    tipo: 'franquicia' },
  MMMORTEROS:      { nombre: 'Morteros',   ciudad: 'Morteros',         zona: 'morteros',   tipo: 'franquicia' },
  MAJARIOCUARTO:   { nombre: 'Rio Cuarto', ciudad: 'Rio Cuarto',       zona: 'rio_cuarto', tipo: 'propio' },
  MAJACARCANO:     { nombre: 'Carcano',    ciudad: 'Carcano',          zona: 'carcano',    tipo: 'propio' },
  MAJAALTAGRACIA:  { nombre: 'Alta Gracia',ciudad: 'Alta Gracia',      zona: 'alta_gracia',tipo: 'franquicia' },
  MAJALOSSAUCES:   { nombre: 'Sol y Rio',  ciudad: 'Villa Carlos Paz', zona: 'carlos_paz', tipo: 'franquicia' },
  MAJAMORENATANTI: { nombre: 'Tanti',      ciudad: 'Tanti',            zona: 'tanti',      tipo: 'franquicia' },
  MAJASANTACRUZ:   { nombre: 'Santa Cruz', ciudad: 'Villa Santa Cruz del Lago', zona: 'santa_cruz', tipo: 'franquicia' },
};

function parseNum(s) {
  if (!s && s !== 0) return 0;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\$/g, '').replace(/,/g, '').trim()) || 0;
}

// fecha_iso = "2026-07-02" → día comercial = 01/07 7am → 02/07 7am
function calcularRango(fecha_iso) {
  const hasta = new Date(fecha_iso + 'T00:00:00');
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - 1);

  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  const isoDate = d => d.toISOString().split('T')[0];

  return {
    fecha_iso,
    fecha_comercial: fmt(desde),
    startDate: isoDate(desde),
    endDate:   isoDate(hasta),
    // ART = UTC-3 → 07:00 ART = 10:00 UTC
    startTimeUTC: `${isoDate(desde)}T10:00:00.000Z`,
    endTimeUTC:   `${isoDate(hasta)}T09:59:00.000Z`,
    label: fmt(desde),
  };
}

function parsearXlsx(rutaArchivo) {
  if (!XLSX) return null;
  const wb = XLSX.readFile(rutaArchivo);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (filas.length < 2) return null;

  const header = filas[0].map(c => String(c).toLowerCase().trim());
  const col = (...ns) => { for (const n of ns) { const i = header.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };

  const C = {
    numero: col('numero', 'nro'),
    total:  col('total'),        efec:  col('efectivo'),
    cred:   col('credito','crédito'), deb: col('debito','débito'),
    vales:  col('vales'),        mp:    col('mercado'),
    saldo:  col('saldo'),
  };
  if (C.total < 0) C.total = 6;
  if (C.efec  < 0) C.efec  = 7;
  if (C.cred  < 0) C.cred  = 8;
  if (C.deb   < 0) C.deb   = 9;
  if (C.vales < 0) C.vales = 10;
  if (C.mp    < 0) C.mp    = 11;
  if (C.saldo < 0) C.saldo = 12;

  let totalizador = null;
  let ops = 0;

  for (let i = 1; i < filas.length; i++) {
    const cols = filas[i];
    if (!cols || cols.length < 4) continue;
    const num = String(cols[C.numero < 0 ? 1 : C.numero] || '').trim();
    if (!num) {
      totalizador = {
        total: parseNum(cols[C.total]), efec:  parseNum(cols[C.efec]),
        cred:  parseNum(cols[C.cred]),  deb:   parseNum(cols[C.deb]),
        vales: parseNum(cols[C.vales]), mp:    parseNum(cols[C.mp]),
        saldo: parseNum(cols[C.saldo]),
      };
    } else { ops++; }
  }

  if (!totalizador && ops > 0) {
    let t=0,ef=0,cr=0,db=0,vl=0,mp=0,sl=0;
    for (let i=1;i<filas.length;i++) {
      const c=filas[i]; if(!c||c.length<4) continue;
      t+=parseNum(c[C.total]);ef+=parseNum(c[C.efec]);cr+=parseNum(c[C.cred]);
      db+=parseNum(c[C.deb]);vl+=parseNum(c[C.vales]);mp+=parseNum(c[C.mp]);sl+=parseNum(c[C.saldo]);
    }
    totalizador = { total:t, efec:ef, cred:cr, deb:db, vales:vl, mp, saldo:sl };
  }
  return totalizador ? { ...totalizador, ops } : null;
}

async function descargarLocalDia(usuario, password, rango) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(NUCLEO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(1000);
    for (const s of [{ u:'#UserName',p:'#Password' },{ u:'input[name="UserName"]',p:'input[name="Password"]' },{ u:'input[type="text"]',p:'input[type="password"]' }]) {
      try {
        await page.waitForSelector(s.u, { timeout: 3000 });
        await page.click(s.u, { clickCount: 3 });
        await page.type(s.u, usuario, { delay: 40 });
        await page.type(s.p, password, { delay: 40 });
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        break;
      } catch {}
    }
    await esperar(1500);

    // Endpoint directo — sin jQuery, sin UI
    const exportUrl = `${NUCLEO_BASE}/NG/Order/ExportSalesHistory` +
      `?ActivationState=0&Branches=1&CustomerId=0` +
      `&EndDate=${rango.endDate}&EndTime=${encodeURIComponent(rango.endTimeUTC)}` +
      `&FiltroDePedido=0&SaleChannels=0&ShowMercadoPago=true&ShowNumberIntegration=false&ShowRappi=false` +
      `&StartDate=${rango.startDate}&StartTime=${encodeURIComponent(rango.startTimeUTC)}&TimeFilter=1`;

    const buffer = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { error: r.status };
        const ab = await r.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
      } catch (e) { return { error: e.message }; }
    }, exportUrl);

    await browser.close();

    if (buffer.error || !buffer.data || buffer.data.length < 100) {
      console.warn(`  [${usuario}] Export error: ${buffer.error || 'vacío'}`);
      return null;
    }

    const archivo = path.join(DESCARGAS_DIR, `${rango.fecha_iso}_${usuario}.xlsx`);
    fs.writeFileSync(archivo, Buffer.from(buffer.data));
    return parsearXlsx(archivo);

  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`  [${usuario}] Error: ${e.message}`);
    return null;
  }
}

async function procesarFecha(fecha_iso, creds) {
  const rango = calcularRango(fecha_iso);
  console.log(`\n=== ${fecha_iso} | Día comercial: ${rango.label} ===`);

  const resultados = [];
  const errores    = [];

  for (const [usuario, info] of Object.entries(LOCALES_MAP)) {
    const cred = creds[usuario];
    if (!cred?.password) continue;

    console.log(`  [${info.nombre}] descargando...`);
    const t = await descargarLocalDia(usuario, cred.password, rango);

    if (t) {
      const venta_real = t.total - t.saldo;
      resultados.push({
        local_id:    usuario.toLowerCase(),
        nombre:      info.nombre,
        ciudad:      info.ciudad,
        zona:        info.zona,
        tipo:        info.tipo,
        venta_real,
        efectivo:    t.efec,
        credito:     t.cred,
        debito:      t.deb,
        mercado_pago:t.mp,
        vales:       t.vales,
        operaciones: t.ops || 0,
        ticket_prom: t.ops > 0 ? Math.round(venta_real / t.ops) : 0,
      });
      console.log(`    ✓ $${venta_real.toLocaleString('es-AR')} (${t.ops} ops)`);
    } else {
      errores.push(usuario);
      console.log(`    ✗ Sin datos`);
    }
    await esperar(1500);
  }

  const ranking_locales = [...resultados].sort((a, b) => b.venta_real - a.venta_real).map((r, i) => ({ puesto: i+1, ...r }));
  const venta_real = resultados.reduce((s, r) => s + r.venta_real, 0);
  const operaciones = resultados.reduce((s, r) => s + r.operaciones, 0);
  const propios    = resultados.filter(r => r.tipo === 'propio');
  const franqs     = resultados.filter(r => r.tipo === 'franquicia');

  // Guardar resumen_diario
  await db.collection('resumen_diario').doc(fecha_iso).set({
    fecha:                fecha_iso,
    fecha_comercial:      rango.label,
    venta_real,
    cantidad_operaciones: operaciones,
    ticket_promedio:      operaciones > 0 ? Math.round(venta_real / operaciones) : 0,
    ranking_locales,
    propios: { venta_real: propios.reduce((s,r)=>s+r.venta_real,0), cantidad_operaciones: propios.reduce((s,r)=>s+r.operaciones,0) },
    franquicias: { venta_real: franqs.reduce((s,r)=>s+r.venta_real,0), cantidad_operaciones: franqs.reduce((s,r)=>s+r.operaciones,0) },
    locales_exitosos:  resultados.length,
    locales_con_error: errores.length,
    descargado_at:     new Date(),
    fuente:            'nucleo_it_directo',
  }, { merge: true });

  console.log(`\n  ✅ resumen_diario/${fecha_iso} guardado: $${venta_real.toLocaleString('es-AR')} (${resultados.length} locales)`);
  return { fecha_iso, venta_real };
}

async function reconstruirMensual(mes) {
  const [y, m] = mes.split('-');
  const hoy = new Date().toISOString().split('T')[0];
  const snap = await db.collection('resumen_diario')
    .where('fecha', '>=', `${y}-${m}-02`)
    .where('fecha', '<=', hoy)
    .get();

  const locales = {};
  const diasIncluidos = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    diasIncluidos.push(doc.id);
    for (const r of (d.ranking_locales || [])) {
      const lid = r.local_id; if (!lid) continue;
      if (!locales[lid]) locales[lid] = { nombre: r.nombre, tipo: r.tipo, venta_real: 0, efectivo: 0, credito: 0, debito: 0, mercado_pago: 0, vales: 0, operaciones: 0 };
      locales[lid].venta_real   += r.venta_real   || 0;
      locales[lid].efectivo     += r.efectivo      || 0;
      locales[lid].credito      += r.credito       || 0;
      locales[lid].debito       += r.debito        || 0;
      locales[lid].mercado_pago += r.mercado_pago  || 0;
      locales[lid].vales        += r.vales         || 0;
      locales[lid].operaciones  += r.operaciones   || 0;
    }
  }

  const venta_real_total = Object.values(locales).reduce((s, l) => s + l.venta_real, 0);
  await db.collection('resumen_mensual').doc(mes).set({
    mes, locales, dias_incluidos: diasIncluidos.sort(),
    ultima_actualizacion: new Date(), venta_real_total,
  });

  console.log(`\n✅ resumen_mensual/${mes} = $${venta_real_total.toLocaleString('es-AR')} (${diasIncluidos.length} días)`);
  Object.entries(locales).sort((a,b) => b[1].venta_real - a[1].venta_real)
    .forEach(([,l]) => console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')}`));
}

(async () => {
  // Fechas a re-descargar: los fecha_iso pasados como argumentos
  // Si no se pasan argumentos, re-descarga los 2 días de julio que están mal
  const args = process.argv.slice(2);
  const fechas = args.length > 0 ? args : ['2026-07-02', '2026-07-03'];

  console.log(`Re-descargando: ${fechas.join(', ')}`);

  const credDoc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  const creds   = credDoc.data() || {};

  for (const fecha of fechas) {
    await procesarFecha(fecha, creds);
  }

  // Reconstruir mensual del mes afectado
  const meses = [...new Set(fechas.map(f => f.slice(0, 7)))];
  for (const mes of meses) {
    await reconstruirMensual(mes);
  }

  process.exit(0);
})().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
