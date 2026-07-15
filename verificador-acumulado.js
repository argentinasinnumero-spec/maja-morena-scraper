'use strict';

/**
 * Verificador de acumulados mensuales.
 *
 * Cada 2 días: descarga el acumulado mensual completo directo de Núcleo IT
 * (un solo request por local para todo el mes) y lo compara contra
 * resumen_mensual en Firestore.
 *
 * Si algún local difiere más del 5%, busca qué días están mal
 * y los re-descarga automáticamente.
 *
 * Guarda en Firestore:
 *   - acumulado_control/{mes}  → totales reales de Núcleo IT por local
 *   - resumen_mensual/{mes}    → se reconstruye si hay diferencias
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
let XLSX;      try { XLSX = require('xlsx'); }           catch {}

const db = admin.firestore();
const esperar = ms => new Promise(r => setTimeout(r, ms));

const DESCARGAS_DIR = path.join(__dirname, 'descargas_nucleo');
if (!fs.existsSync(DESCARGAS_DIR)) fs.mkdirSync(DESCARGAS_DIR, { recursive: true });

const NUCLEO_BASE  = 'https://nucleoit.com.ar';
const NUCLEO_LOGIN = `${NUCLEO_BASE}/Account/LogOn?ReturnUrl=%2fNG%2fClientesGastronomico%2fIndex`;
const TOLERANCIA   = 0.05; // 5% de diferencia máxima aceptable

const LOCALES_MAP = {
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

function fechaArgentina() {
  const now = new Date();
  now.setHours(now.getUTCHours() - 3);
  return now.toISOString().split('T')[0];
}

function primerDiaDelMes(fechaIso) {
  return fechaIso.slice(0, 7) + '-01';
}

function parsearXlsx(rutaArchivo) {
  if (!XLSX) { console.error('XLSX no disponible'); return null; }
  const wb = XLSX.readFile(rutaArchivo);
  const ws = wb.Sheets[wb.SheetNames[0]];
  const filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  if (filas.length < 2) return null;

  const normalizar = s => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim();
  const header = filas[0].map(normalizar);
  const col = (...ns) => { for (const n of ns) { const i = header.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };

  const C = {
    numero: col('numero', 'nro'),
    total:  col('total'), efec: col('efectivo'),
    cred:   col('credito'), deb: col('debito'),
    vales:  col('vales'),   mp:  col('mercado'),
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
        total: parseNum(cols[C.total]), saldo: parseNum(cols[C.saldo]),
      };
    } else { ops++; }
  }

  if (!totalizador && ops > 0) {
    let t = 0, sl = 0;
    for (let i = 1; i < filas.length; i++) {
      const c = filas[i]; if (!c || c.length < 4) continue;
      t += parseNum(c[C.total]); sl += parseNum(c[C.saldo]);
    }
    totalizador = { total: t, saldo: sl };
  }
  return totalizador ? { venta_real: totalizador.total - totalizador.saldo, ops } : null;
}

async function descargarAcumuladoLocal(usuario, password, startDate, endDate) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.goto(NUCLEO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(1000);

    for (const s of [{ u: '#UserName', p: '#Password' }, { u: 'input[name="UserName"]', p: 'input[name="Password"]' }, { u: 'input[type="text"]', p: 'input[type="password"]' }]) {
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

    // Acumulado mensual: desde día 1 del mes 07:00 ART hasta hoy 07:00 ART
    const startTimeUTC = `${startDate}T10:00:00.000Z`; // 07:00 ART
    const endTimeUTC   = `${endDate}T09:59:00.000Z`;   // 06:59 ART del día siguiente

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

    if (buffer.error || !buffer.data || buffer.data.length < 100) return null;

    const archivo = path.join(DESCARGAS_DIR, `control_${usuario}_${endDate}.xlsx`);
    fs.writeFileSync(archivo, Buffer.from(buffer.data));
    return parsearXlsx(archivo);

  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`  [${usuario}] Error: ${e.message}`);
    return null;
  }
}

async function reconstruirMensual(mes) {
  const [y, m] = mes.split('-');
  const hoy = fechaArgentina();
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
  return { locales, diasIncluidos, venta_real_total };
}

async function redownloadDia(fecha_iso, creds) {
  const { descargarFechaEspecifica } = require('./tools/nucleoConector');
  const hasta = new Date(fecha_iso + 'T00:00:00');
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - 1);
  const fechaComercial = desde.toISOString().split('T')[0];
  console.log(`    → Re-descargando día comercial ${fechaComercial} (doc ${fecha_iso})...`);
  try {
    const datos = await descargarFechaEspecifica(fechaComercial);
    console.log(`      ✓ $${datos.venta_real?.toLocaleString('es-AR')} (${datos.locales_exitosos} locales)`);
    return true;
  } catch (e) {
    console.error(`      ✗ ${e.message}`);
    return false;
  }
}

(async () => {
  console.log('[Verificador] Iniciando —', new Date().toISOString());

  const hoy = fechaArgentina();
  const mes = hoy.slice(0, 7);
  const [y, m] = mes.split('-');

  // El mes empieza comercialmente el día 2 (el doc del día 1 tiene el último día del mes anterior)
  const startDate = `${y}-${m}-01`; // 1ro del mes a las 07:00 ART
  const endDate   = hoy;            // hoy a las 07:00 ART (cierre del día comercial de ayer)

  console.log(`[Verificador] Período: ${startDate} → ${endDate} (mes ${mes})`);

  // Leer credenciales
  const credDoc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  const creds   = credDoc.data() || {};

  // Paso 1: Descargar acumulado real de Núcleo IT por local
  console.log('\n[Verificador] Descargando acumulados reales de Núcleo IT...');
  const acumuladoControl = {};
  let totalControl = 0;

  for (const [usuario, info] of Object.entries(LOCALES_MAP)) {
    if (!creds[usuario]?.password) continue;
    process.stdout.write(`  [${info.nombre}] ...`);
    const t = await descargarAcumuladoLocal(usuario, creds[usuario].password, startDate, endDate);
    if (t) {
      acumuladoControl[usuario.toLowerCase()] = { nombre: info.nombre, tipo: info.tipo, venta_real: t.venta_real };
      totalControl += t.venta_real;
      console.log(` $${t.venta_real.toLocaleString('es-AR')}`);
    } else {
      console.log(' ✗ sin datos');
    }
    await esperar(1500);
  }

  // Guardar acumulado_control en Firestore
  await db.collection('acumulado_control').doc(mes).set({
    mes,
    locales: acumuladoControl,
    venta_real_total: totalControl,
    periodo: { desde: startDate, hasta: endDate },
    verificado_at: new Date(),
  });
  console.log(`\n[Verificador] Control guardado: $${totalControl.toLocaleString('es-AR')}`);

  // Paso 2: Comparar contra resumen_mensual
  const mesSnap = await db.collection('resumen_mensual').doc(mes).get();
  const mesData = mesSnap.exists ? mesSnap.data() : null;
  const localesMes = mesData?.locales || {};

  console.log('\n[Verificador] Comparando acumulados...');
  const localesConDiferencia = [];

  for (const [lid, ctrl] of Object.entries(acumuladoControl)) {
    const firestore = localesMes[lid]?.venta_real || 0;
    const control   = ctrl.venta_real;
    if (control === 0) continue;

    const diff = Math.abs(control - firestore) / control;
    const diffPct = (diff * 100).toFixed(1);
    const estado = diff > TOLERANCIA ? '⚠️ DIFIERE' : '✓';
    console.log(`  ${estado} ${ctrl.nombre.padEnd(12)} Control: $${control.toLocaleString('es-AR')} | Firestore: $${firestore.toLocaleString('es-AR')} | Diff: ${diffPct}%`);

    if (diff > TOLERANCIA) {
      localesConDiferencia.push({ lid, nombre: ctrl.nombre, control, firestore, diff });
    }
  }

  if (localesConDiferencia.length === 0) {
    console.log('\n[Verificador] ✅ Todo coincide. Acumulados correctos.');
    process.exit(0);
  }

  // Paso 3: Hay diferencias → buscar qué días están mal y re-descargarlos
  console.log(`\n[Verificador] ⚠️ ${localesConDiferencia.length} locales con diferencia. Buscando días incorrectos...`);

  // Obtener todos los docs del mes
  const diasSnap = await db.collection('resumen_diario')
    .where('fecha', '>=', `${y}-${m}-02`)
    .where('fecha', '<=', hoy)
    .get();

  const diasConError = new Set();

  for (const { lid, nombre } of localesConDiferencia) {
    console.log(`\n  Revisando días de ${nombre}...`);
    for (const doc of diasSnap.docs) {
      const d = doc.data();
      const ranking = d.ranking_locales || [];
      const localDia = ranking.find(r => r.local_id === lid);
      // Si el local no aparece ese día o tiene venta 0, es candidato
      if (!localDia || localDia.venta_real === 0) {
        console.log(`    ⚠️ ${doc.id}: ${nombre} = $${localDia?.venta_real || 0}`);
        diasConError.add(doc.id);
      }
    }
  }

  if (diasConError.size === 0) {
    // No encontró días con $0 obvio — re-descargar todos los días del mes
    console.log('  No se encontraron días con $0 obvio — re-descargando todo el mes...');
    for (const doc of diasSnap.docs) diasConError.add(doc.id);
  }

  console.log(`\n[Verificador] Re-descargando ${diasConError.size} días: ${[...diasConError].sort().join(', ')}`);

  for (const fecha of [...diasConError].sort()) {
    await redownloadDia(fecha, creds);
  }

  // Reconstruir mensual
  await reconstruirMensual(mes);
  console.log('\n[Verificador] ✅ Corrección completada.');
  process.exit(0);

})().catch(e => {
  console.error('[Verificador] Error fatal:', e.message);
  process.exit(1);
});
