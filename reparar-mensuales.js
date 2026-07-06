'use strict';

/**
 * Repara resumen_mensual de junio y julio:
 * - Junio: baja el total directo de Núcleo IT (01/06 → 01/07 7hs) — fuente de verdad
 * - Julio: reconstruye sumando los resumen_diario de julio que ya están en Firestore
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

function parseNum(s) {
  if (!s && s !== 0) return 0;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\$/g, '').replace(/,/g, '').trim()) || 0;
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
    total:  col('total'),
    efec:   col('efectivo'),
    cred:   col('credito', 'crédito'),
    deb:    col('debito', 'débito'),
    vales:  col('vales'),
    mp:     col('mercado'),
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
      totalizador = { total: parseNum(cols[C.total]), efec: parseNum(cols[C.efec]), cred: parseNum(cols[C.cred]), deb: parseNum(cols[C.deb]), vales: parseNum(cols[C.vales]), mp: parseNum(cols[C.mp]), saldo: parseNum(cols[C.saldo]) };
    } else { ops++; }
  }

  if (!totalizador && ops > 0) {
    let t=0,ef=0,cr=0,db=0,vl=0,mp=0,sl=0;
    for (let i=1;i<filas.length;i++) { const c=filas[i]; if(!c||c.length<4)continue; t+=parseNum(c[C.total]);ef+=parseNum(c[C.efec]);cr+=parseNum(c[C.cred]);db+=parseNum(c[C.deb]);vl+=parseNum(c[C.vales]);mp+=parseNum(c[C.mp]);sl+=parseNum(c[C.saldo]); }
    totalizador = { total:t, efec:ef, cred:cr, deb:db, vales:vl, mp, saldo:sl };
  }

  return totalizador ? { ...totalizador, ops } : null;
}

async function descargarMesLocal(usuario, password, startDate, endDate, startTimeUTC, endTimeUTC, label) {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    await page.goto(NUCLEO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(1000);
    for (const sel of [{ u:'#UserName',p:'#Password' },{ u:'input[name="UserName"]',p:'input[name="Password"]' },{ u:'input[type="text"]',p:'input[type="password"]' }]) {
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

    const exportUrl = `${NUCLEO_BASE}/NG/Order/ExportSalesHistory` +
      `?ActivationState=0&Branches=1&CustomerId=0` +
      `&EndDate=${endDate}&EndTime=${encodeURIComponent(endTimeUTC)}` +
      `&FiltroDePedido=0&SaleChannels=0&ShowMercadoPago=true&ShowNumberIntegration=false&ShowRappi=false` +
      `&StartDate=${startDate}&StartTime=${encodeURIComponent(startTimeUTC)}&TimeFilter=1`;

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
      console.warn(`  [Export ${usuario}] Error: ${buffer.error || 'vacío'}`);
      return null;
    }

    const archivo = path.join(DESCARGAS_DIR, `${label}_${usuario}.xlsx`);
    fs.writeFileSync(archivo, Buffer.from(buffer.data));
    console.log(`  ✓ ${buffer.data.length} bytes guardados`);
    return parsearXlsx(archivo);

  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`  Error: ${e.message}`);
    return null;
  }
}

async function repararMesDirecto(mes, startDate, endDate, startTimeUTC, endTimeUTC) {
  console.log(`\n=== REPARANDO ${mes} (descarga directa Núcleo IT) ===`);
  console.log(`    ${startDate} 07hs → ${endDate} 07hs ART\n`);

  const credDoc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  const creds   = credDoc.data() || {};
  const localesResult = {};

  for (const [usuario, info] of Object.entries(LOCALES)) {
    const cred = creds[usuario];
    if (!cred?.password) { console.log(`[${info.nombre}] Sin credencial, skip`); continue; }

    console.log(`[${info.nombre}] Descargando...`);
    const t = await descargarMesLocal(usuario, cred.password, startDate, endDate, startTimeUTC, endTimeUTC, mes);

    if (t) {
      const venta_real = t.total - t.saldo;
      localesResult[usuario] = {
        nombre: info.nombre, tipo: info.tipo, local_id: usuario,
        venta_real, efectivo: t.efec, credito: t.cred, debito: t.deb,
        mercado_pago: t.mp, vales: t.vales, operaciones: t.ops || 0,
      };
      console.log(`  → $${venta_real.toLocaleString('es-AR')} (${t.ops} ops)`);
    } else {
      console.log(`  ✗ Sin datos`);
    }
    await esperar(2000);
  }

  const venta_real_total = Object.values(localesResult).reduce((s, l) => s + l.venta_real, 0);
  await db.collection('resumen_mensual').doc(mes).set({
    mes, locales: localesResult, dias_incluidos: [],
    ultima_actualizacion: new Date(), venta_real_total,
    nota: `Descarga directa Núcleo IT ${startDate}→${endDate}`,
  });

  console.log(`\n✅ resumen_mensual/${mes} = $${venta_real_total.toLocaleString('es-AR')}`);
  Object.values(localesResult).sort((a,b) => b.venta_real - a.venta_real)
    .forEach(l => console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')}`));
}

async function repararMesDesdeFirestore(mes) {
  console.log(`\n=== REPARANDO ${mes} (sumando resumen_diario) ===`);

  const [y, m] = mes.split('-');
  // El doc del día 1 de cada mes contiene el día comercial del último día del mes anterior → excluir
  // El día comercial de hoy se guarda como mañana (aún no terminó) → cap en hoy
  const hoy = new Date().toISOString().split('T')[0];
  const snap = await db.collection('resumen_diario')
    .where('fecha', '>=', `${y}-${m}-02`)
    .where('fecha', '<=', hoy)
    .get();

  console.log(`  ${snap.size} docs encontrados`);

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

  console.log(`✅ resumen_mensual/${mes} = $${venta_real_total.toLocaleString('es-AR')} (${diasIncluidos.length} días)`);
  Object.entries(locales).sort((a,b) => b[1].venta_real - a[1].venta_real)
    .forEach(([,l]) => console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')}`));
}

(async () => {
  // JUNIO: descarga directa desde Núcleo IT (datos correctos garantizados)
  // 01/06/2026 07:00 ART → 01/07/2026 07:00 ART (captura todos los días comerciales de junio)
  await repararMesDirecto('2026-06',
    '2026-06-01', '2026-07-01',
    '2026-06-01T10:00:00.000Z',  // 07:00 ART
    '2026-07-01T09:59:00.000Z',  // 06:59 ART del 1 de julio
  );

  // JULIO: sumar los resumen_diario que ya están en Firestore
  // (los datos diarios son correctos — el problema era solo el mensual acumulado)
  await repararMesDesdeFirestore('2026-07');

  console.log('\n✅ Reparación completa. Ambos meses corregidos.');
  process.exit(0);
})().catch(e => { console.error('Error fatal:', e.message); process.exit(1); });
