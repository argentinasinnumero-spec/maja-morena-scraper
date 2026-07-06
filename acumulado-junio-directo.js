'use strict';

/**
 * Descarga el acumulado de JUNIO COMPLETO (01/06 → 26/06, 07:00 → 07:00) por local
 * desde Núcleo IT usando el endpoint ExportSalesHistory — una sola descarga por local,
 * sin riesgo de filtros fallidos día por día.
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

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }
let XLSX;
try { XLSX = require('xlsx'); } catch { XLSX = null; }

const db = admin.firestore();
const esperar = ms => new Promise(r => setTimeout(r, ms));

const DESCARGAS_DIR = path.join(__dirname, 'descargas_nucleo');
if (!fs.existsSync(DESCARGAS_DIR)) fs.mkdirSync(DESCARGAS_DIR, { recursive: true });

const NUCLEO_BASE  = 'https://nucleoit.com.ar';
const NUCLEO_LOGIN = `${NUCLEO_BASE}/Account/LogOn?ReturnUrl=%2fNG%2fClientesGastronomico%2fIndex`;

const LOCALES = {
  MAJAMORENA:      { nombre: 'Libertad',   tipo: 'propio' },
  MAJASANMARTIN:   { nombre: 'San Martin', tipo: 'propio' },
  MAJASANMARTIN58: { nombre: 'Express',    tipo: 'propio' },
  MAJASARMIENTO:   { nombre: 'Sarmiento',  tipo: 'propio' },
  MAJAMORENAWO:    { nombre: 'WO',         tipo: 'propio' },
  MAJACOSQUIN:     { nombre: 'Cosquin',    tipo: 'franquicia' },
  MMMORTEROS:      { nombre: 'Morteros',   tipo: 'franquicia' },
  MAJARIOCUARTO:   { nombre: 'Rio Cuarto', tipo: 'propio' },
  MAJACARCANO:     { nombre: 'Carcano',    tipo: 'propio' },
  MAJAALTAGRACIA:  { nombre: 'Alta Gracia',tipo: 'franquicia' },
  MAJALOSSAUCES:   { nombre: 'Sol y Rio',  tipo: 'franquicia' },
  MAJAMORENATANTI: { nombre: 'Tanti',      tipo: 'franquicia' },
  MAJASANTACRUZ:   { nombre: 'Santa Cruz', tipo: 'franquicia' },
};

// Rango junio: 01/06/2026 07:00 ART → 27/06/2026 07:00 ART
// ART = UTC-3 → 07:00 ART = 10:00 UTC
const RANGO_JUNIO = {
  startDate: '2026-06-01',
  endDate:   '2026-06-27',       // hasta el 27 07:00 para capturar el día comercial del 26
  startTime: '2026-06-01T10:00:00.000Z',
  endTime:   '2026-06-27T09:59:00.000Z',
  fecha_desde: '01/06/2026',
  fecha_hasta: '27/06/2026',
  range_string: '01/06/2026 - 27/06/2026',
};

function parseNum(s) {
  if (s === null || s === undefined || s === '') return 0;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\$/g, '').replace(/,/g, '').trim()) || 0;
}

function parsearXlsx(rutaArchivo) {
  if (!XLSX) { console.warn('  xlsx no disponible'); return null; }
  const wb = XLSX.readFile(rutaArchivo);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });

  if (filas.length < 2) return null;

  const header = filas[0].map(c => String(c).toLowerCase().trim());
  const col = (...nombres) => {
    for (const n of nombres) {
      const idx = header.findIndex(h => h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const C = {
    numero:       col('numero', 'nro', 'num'),
    total:        col('total'),
    efectivo:     col('efectivo'),
    credito:      col('credito', 'crédito', 't.cr'),
    debito:       col('debito',  'débito',  't.d'),
    vales:        col('vales'),
    mercado_pago: col('mercado', 'mp'),
    saldo:        col('saldo'),
    operaciones:  -1,
  };

  // Fallback índices fijos (Nucleo IT conocido)
  if (C.total < 0)        C.total        = 6;
  if (C.efectivo < 0)     C.efectivo     = 7;
  if (C.credito < 0)      C.credito      = 8;
  if (C.debito < 0)       C.debito       = 9;
  if (C.vales < 0)        C.vales        = 10;
  if (C.mercado_pago < 0) C.mercado_pago = 11;
  if (C.saldo < 0)        C.saldo        = 12;

  let totalizador = null;
  let operaciones = 0;

  for (let i = 1; i < filas.length; i++) {
    const cols = filas[i];
    if (!cols || cols.length < 4) continue;
    const numero = String(cols[C.numero < 0 ? 1 : C.numero] || '').trim();
    if (!numero || numero === '') {
      // fila totalizadora
      totalizador = {
        total:        parseNum(cols[C.total]),
        efectivo:     parseNum(cols[C.efectivo]),
        credito:      parseNum(cols[C.credito]),
        debito:       parseNum(cols[C.debito]),
        vales:        parseNum(cols[C.vales]),
        mercado_pago: parseNum(cols[C.mercado_pago]),
        saldo:        parseNum(cols[C.saldo]),
      };
    } else {
      operaciones++;
    }
  }

  if (!totalizador && operaciones > 0) {
    // sumar manualmente si no hay fila totalizadora
    let t = 0, ef = 0, cr = 0, db = 0, vl = 0, mp = 0, sl = 0;
    for (let i = 1; i < filas.length; i++) {
      const cols = filas[i];
      if (!cols || cols.length < 4) continue;
      t  += parseNum(cols[C.total]);
      ef += parseNum(cols[C.efectivo]);
      cr += parseNum(cols[C.credito]);
      db += parseNum(cols[C.debito]);
      vl += parseNum(cols[C.vales]);
      mp += parseNum(cols[C.mercado_pago]);
      sl += parseNum(cols[C.saldo]);
    }
    totalizador = { total: t, efectivo: ef, credito: cr, debito: db, vales: vl, mercado_pago: mp, saldo: sl };
  }

  return totalizador ? { ...totalizador, operaciones } : null;
}

async function descargarLocal(usuario, password) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Login
    await page.goto(NUCLEO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(1000);
    const intentos = [
      { u: '#UserName', p: '#Password' },
      { u: 'input[name="UserName"]', p: 'input[name="Password"]' },
      { u: 'input[type="text"]', p: 'input[type="password"]' },
    ];
    for (const sel of intentos) {
      try {
        await page.waitForSelector(sel.u, { timeout: 3000 });
        await page.click(sel.u, { clickCount: 3 });
        await page.type(sel.u, usuario, { delay: 40 });
        await page.type(sel.p, password, { delay: 40 });
        await page.keyboard.press('Enter');
        await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
        break;
      } catch {}
    }
    await esperar(1500);

    // 2. Descargar via endpoint directo ExportSalesHistory (sin UI)
    // startDate y endDate en formato YYYY-MM-DD
    // startTime y endTime en UTC (07:00 ART = 10:00 UTC)
    const exportUrl = `${NUCLEO_BASE}/NG/Order/ExportSalesHistory` +
      `?ActivationState=0&Branches=1&CustomerId=0` +
      `&EndDate=${RANGO_JUNIO.endDate}&EndTime=${encodeURIComponent(RANGO_JUNIO.endTime)}` +
      `&FiltroDePedido=0&SaleChannels=0&ShowMercadoPago=true&ShowNumberIntegration=false&ShowRappi=false` +
      `&StartDate=${RANGO_JUNIO.startDate}&StartTime=${encodeURIComponent(RANGO_JUNIO.startTime)}&TimeFilter=1`;

    console.log(`  [Export] ${RANGO_JUNIO.startDate} 07hs → ${RANGO_JUNIO.endDate} 07hs ART`);

    const buffer = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url, { credentials: 'include' });
        if (!r.ok) return { error: r.status };
        const ab = await r.arrayBuffer();
        return { data: Array.from(new Uint8Array(ab)) };
      } catch (e) {
        return { error: e.message };
      }
    }, exportUrl);

    await browser.close();

    if (buffer.error || !buffer.data || buffer.data.length < 100) {
      console.warn(`  [Export] Respuesta vacía o error: ${buffer.error || buffer.data?.length}`);
      return null;
    }

    const nombreArchivo = `junio2026_${usuario}.xlsx`;
    const rutaArchivo   = path.join(DESCARGAS_DIR, nombreArchivo);
    fs.writeFileSync(rutaArchivo, Buffer.from(buffer.data));
    console.log(`  [Export] Archivo guardado: ${nombreArchivo} (${buffer.data.length} bytes)`);

    return parsearXlsx(rutaArchivo);

  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`  Error: ${e.message}`);
    return null;
  }
}

(async () => {
  console.log('=== ACUMULADO JUNIO DIRECTO DESDE NÚCLEO IT ===');
  console.log(`    Rango: 01/06/2026 07:00 → 27/06/2026 07:00 ART\n`);

  const credDoc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  const creds   = credDoc.data() || {};

  const localesResult = {};

  for (const [usuario, info] of Object.entries(LOCALES)) {
    const cred = creds[usuario];
    if (!cred?.password) {
      console.log(`[${info.nombre}] Sin credencial, skip`);
      continue;
    }

    console.log(`[${info.nombre}] Descargando...`);
    const totales = await descargarLocal(usuario, cred.password);

    if (totales) {
      const ventaReal = totales.total - totales.saldo;
      localesResult[usuario] = {
        nombre:       info.nombre,
        tipo:         info.tipo,
        local_id:     usuario,
        venta_real:   ventaReal,
        efectivo:     totales.efectivo     || 0,
        credito:      totales.credito      || 0,
        debito:       totales.debito       || 0,
        mercado_pago: totales.mercado_pago || 0,
        vales:        totales.vales        || 0,
        operaciones:  totales.operaciones  || 0,
      };
      console.log(`  ✓ Total: $${totales.total.toLocaleString('es-AR')} | Saldo: $${totales.saldo.toLocaleString('es-AR')} | Venta real: $${ventaReal.toLocaleString('es-AR')} (${totales.operaciones} ops)`);
    } else {
      console.log(`  ✗ Sin datos`);
    }

    await esperar(2000);
  }

  const venta_real_total = Object.values(localesResult).reduce((s, l) => s + l.venta_real, 0);

  await db.collection('resumen_mensual').doc('2026-06').set({
    mes:                  '2026-06',
    locales:              localesResult,
    dias_incluidos:       [],
    ultima_actualizacion: new Date(),
    venta_real_total,
    nota:                 'Acumulado directo Núcleo IT 01/06-26/06 07hs',
  });

  console.log(`\n✅ resumen_mensual/2026-06 actualizado:`);
  console.log(`   Total mes: $${venta_real_total.toLocaleString('es-AR')}`);
  console.log('\nDetalle:');
  Object.values(localesResult)
    .sort((a, b) => b.venta_real - a.venta_real)
    .forEach(l =>
      console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')} (${l.operaciones} ops)`)
    );

  process.exit(0);
})().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
