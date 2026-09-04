'use strict';

/**
 * Re-descarga leyendo el totalizador directamente del DOM (sin Export).
 * Usar cuando el endpoint ExportSalesHistory devuelve 500.
 * Uso: node redownload-dom.js 2026-08-22
 */

require('dotenv').config();
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })});
}

let puppeteer; try { puppeteer = require('puppeteer'); } catch {}
const db = admin.firestore();
const esperar = ms => new Promise(r => setTimeout(r, ms));

const NUCLEO_BASE  = 'https://nucleoit.com.ar';
const NUCLEO_LOGIN = `${NUCLEO_BASE}/Account/LogOn?ReturnUrl=%2fNG%2fClientesGastronomico%2fIndex`;

const LOCALES_MAP = {
  MAJAMORENA:      { nombre: 'Libertad',   ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'propio' },
  MAJASANMARTIN:   { nombre: 'San Martin', ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'propio' },
  MAJASANMARTIN58: { nombre: 'Express',    ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'propio' },
  MAJASARMIENTO:   { nombre: 'Sarmiento',  ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'propio' },
  MAJAMORENAWO:    { nombre: 'WO',         ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'propio' },
  MAJACOSQUIN:     { nombre: 'Cosquin',    ciudad: 'Cosquin',          zona: 'cosquin',     tipo: 'franquicia' },
  MMMORTEROS:      { nombre: 'Morteros',   ciudad: 'Morteros',         zona: 'morteros',    tipo: 'franquicia' },
  MAJARIOCUARTO:   { nombre: 'Rio Cuarto', ciudad: 'Rio Cuarto',       zona: 'rio_cuarto',  tipo: 'propio' },
  MAJACARCANO:     { nombre: 'Carcano',    ciudad: 'Carcano',          zona: 'carcano',     tipo: 'propio' },
  MAJAALTAGRACIA:  { nombre: 'Alta Gracia',ciudad: 'Alta Gracia',      zona: 'alta_gracia', tipo: 'franquicia' },
  MAJALOSSAUCES:   { nombre: 'Sol y Rio',  ciudad: 'Villa Carlos Paz', zona: 'carlos_paz',  tipo: 'franquicia' },
  MAJAMORENATANTI: { nombre: 'Tanti',      ciudad: 'Tanti',            zona: 'tanti',       tipo: 'franquicia' },
  MAJASANTACRUZ:   { nombre: 'Santa Cruz', ciudad: 'Villa Santa Cruz del Lago', zona: 'santa_cruz', tipo: 'franquicia' },
};

function parseNum(s) {
  if (!s && s !== 0) return 0;
  if (typeof s === 'number') return s;
  return parseFloat(String(s).replace(/\$/g,'').replace(/\./g,'').replace(/,/g,'.').trim()) || 0;
}

function calcularRango(fecha_iso) {
  const hasta = new Date(fecha_iso + 'T00:00:00');
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - 1);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;
  return { fecha_iso, label: fmt(desde), fecha_desde: fmt(desde), fecha_hasta: fmt(hasta) };
}

async function descargarLocalDOM(usuario, password, rango, nombreLocal) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'],
  });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // Login
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

    // Navegar a historial y esperar que el daterangepicker esté inicializado
    await page.goto(`${NUCLEO_BASE}/NG/Order/HistorialDePedidos`, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    // Esperar explícitamente a que jQuery y el daterangepicker estén listos
    await page.waitForFunction(() => {
      const $ = window.jQuery || window.$;
      if (!$) return false;
      let found = false;
      $('input').each(function() { if ($(this).data('daterangepicker')) { found = true; return false; } });
      return found;
    }, { timeout: 10000 }).catch(() => {});
    await esperar(1000);

    // Verificar si la fecha por defecto ya es la que necesitamos (evita tocar el picker)
    const valorDefault = await page.evaluate(() => {
      // Leer todos los inputs y también el innerText del botón/span del daterangepicker
      const inputs = Array.from(document.querySelectorAll('input'));
      const inp = inputs.find(el => el.value && /\d{2}\/\d{2}\/\d{4}/.test(el.value));
      if (inp) return inp.value;
      // Para pickers que muestran el texto en el input pero .value="" (e.g. AngularJS bindings)
      const $ = window.jQuery || window.$;
      if ($) {
        let v = '';
        $('input').each(function() { const val = $(this).val(); if (/\d{2}\/\d{2}\/\d{4}/.test(val)) { v = val; return false; } });
        if (v) return v;
      }
      return '';
    });

    const rangoEsperado = `${rango.fecha_desde} - ${rango.fecha_hasta}`;

    // Si la fecha por defecto ya es la correcta, no tocar el picker
    let fechaConfirmada = valorDefault.includes(rango.fecha_desde) && valorDefault.includes(rango.fecha_hasta);
    if (fechaConfirmada) {
      console.log(`    [Filtro] Fecha por defecto ya correcta: ${valorDefault}`);
    } else {
      // Setear fechas via jQuery daterangepicker
      await page.evaluate((desde, hasta) => {
        const $ = window.jQuery || window.$;
        if (!$) return;
        $('input').each(function() {
          const drp = $(this).data('daterangepicker');
          if (drp) {
            drp.setStartDate(desde);
            drp.setEndDate(hasta);
            if (typeof drp.updateElement === 'function') drp.updateElement();
            $(this).trigger('apply.daterangepicker', drp);
          }
        });
      }, rango.fecha_desde, rango.fecha_hasta);
      await esperar(800);

      // Verificar que el input muestra el rango correcto
      const valorActual = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const dateInput = inputs.find(el => el.value && /\d{2}\/\d{2}\/\d{4}/.test(el.value));
        if (dateInput) return dateInput.value;
        const $ = window.jQuery || window.$;
        if ($) {
          let v = '';
          $('input').each(function() { const val = $(this).val(); if (/\d{2}\/\d{2}\/\d{4}/.test(val)) { v = val; return false; } });
          if (v) return v;
        }
        return '';
      });

      fechaConfirmada = valorActual.includes(rango.fecha_desde) && valorActual.includes(rango.fecha_hasta);
      if (fechaConfirmada) {
        console.log(`    [Filtro] Fecha confirmada: ${valorActual}`);
      } else {
        console.warn(`    [Filtro] Valor actual: "${valorActual}", esperado "${rangoEsperado}" — reintentando con reload...`);
      // Recargar y reintentar una vez más con más tiempo
      await page.goto(`${NUCLEO_BASE}/NG/Order/HistorialDePedidos`, { waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await page.waitForFunction(() => {
        const $ = window.jQuery || window.$;
        if (!$) return false;
        let found = false;
        $('input').each(function() { if ($(this).data('daterangepicker')) { found = true; return false; } });
        return found;
      }, { timeout: 12000 }).catch(() => {});
      await esperar(1000);
      await page.evaluate((desde, hasta) => {
        const $ = window.jQuery || window.$;
        if (!$) return;
        $('input').each(function() {
          const drp = $(this).data('daterangepicker');
          if (drp) {
            drp.setStartDate(desde);
            drp.setEndDate(hasta);
            if (typeof drp.updateElement === 'function') drp.updateElement();
            $(this).trigger('apply.daterangepicker', drp);
          }
        });
      }, rango.fecha_desde, rango.fecha_hasta);
      await esperar(1000);
      const valorRetry = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const dateInput = inputs.find(el => el.value && /\d{2}\/\d{2}\/\d{4}/.test(el.value));
        return dateInput ? dateInput.value : '';
      });
      fechaConfirmada = valorRetry.includes(rango.fecha_desde) && valorRetry.includes(rango.fecha_hasta);
      if (fechaConfirmada) {
        console.log(`    [Filtro] Fecha confirmada (retry): ${valorRetry}`);
      } else {
        console.warn(`    [Filtro] Retry: "${valorRetry}" — abortando`);
      }
      } // fin else retry
    } // fin else setear fecha

    if (!fechaConfirmada) {
      console.error(`    [Filtro] No se pudo confirmar la fecha correcta para ${usuario}. Abortando.`);
      await browser.close();
      return null;
    }

    // Setear horas 07:00 con verificación
    await page.evaluate(() => {
      const times = document.querySelectorAll('input[type="time"]');
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      if (times[0]) { setter.call(times[0], '07:00'); times[0].dispatchEvent(new Event('input', { bubbles: true })); times[0].dispatchEvent(new Event('change', { bubbles: true })); }
      if (times[1]) { setter.call(times[1], '07:00'); times[1].dispatchEvent(new Event('input', { bubbles: true })); times[1].dispatchEvent(new Event('change', { bubbles: true })); }
    });
    await esperar(400);

    // Verificar horas
    const horas = await page.evaluate(() => {
      const times = document.querySelectorAll('input[type="time"]');
      return [times[0]?.value, times[1]?.value];
    });
    console.log(`    [Filtro] Horas: ${horas[0]} → ${horas[1]}`);

    // Click Listar
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button, a, input[type="button"]'));
      const listar = btns.find(b => (b.innerText||b.value||'').toLowerCase().includes('listar'));
      if (listar) listar.click();
    });
    await esperar(4000);

    // Leer totalizador del DOM
    const resultado = await page.evaluate(() => {
      const tabla = document.querySelector('table');
      if (!tabla) return null;
      const filas = Array.from(tabla.querySelectorAll('tbody tr'));
      if (filas.length === 0) return null;

      // Header
      const ths = Array.from(tabla.querySelectorAll('thead th, thead td'));
      const header = ths.map(th => (th.innerText || th.textContent || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,'').trim());

      const col = (...ns) => { for (const n of ns) { const i = header.findIndex(h => h.includes(n)); if (i >= 0) return i; } return -1; };
      const C = {
        numero: col('numero','nro'), total: col('total'), efectivo: col('efectivo'),
        credito: col('credito','crédito'), debito: col('debito','débito'),
        vales: col('vales'), mp: col('mercado'), saldo: col('saldo'),
      };

      // Buscar fila totalizadora (sin número de pedido)
      let totRow = null;
      let ops = 0;
      for (const fila of filas) {
        const celdas = Array.from(fila.querySelectorAll('td'));
        if (celdas.length < 4) continue;
        const numCell = C.numero >= 0 ? (celdas[C.numero]?.innerText || '') : (celdas[1]?.innerText || '');
        if (!numCell.trim() || numCell.trim() === '0') {
          totRow = celdas.map(c => (c.innerText || c.textContent || '').trim());
        } else {
          ops++;
        }
      }

      if (!totRow && ops > 0) {
        // Sumar manualmente
        let t=0,ef=0,cr=0,db=0,vl=0,mp=0,sl=0;
        for (const fila of filas) {
          const c = Array.from(fila.querySelectorAll('td')).map(x => (x.innerText||'').trim());
          const p = s => parseFloat(String(s).replace(/\$/g,'').replace(/\./g,'').replace(/,/g,'.').trim()) || 0;
          if (C.total >= 0) t  += p(c[C.total]);
          if (C.efectivo >= 0) ef += p(c[C.efectivo]);
          if (C.credito >= 0) cr += p(c[C.credito]);
          if (C.debito >= 0) db += p(c[C.debito]);
          if (C.vales >= 0) vl += p(c[C.vales]);
          if (C.mp >= 0) mp += p(c[C.mp]);
          if (C.saldo >= 0) sl += p(c[C.saldo]);
        }
        return { total: t, efec: ef, cred: cr, deb: db, vales: vl, mp, saldo: sl, ops };
      }

      if (!totRow) return { ops: 0, total: 0, efec: 0, cred: 0, deb: 0, vales: 0, mp: 0, saldo: 0 };

      const p = s => parseFloat(String(s).replace(/\$/g,'').replace(/\./g,'').replace(/,/g,'.').trim()) || 0;
      return {
        total:  C.total  >= 0 ? p(totRow[C.total])    : 0,
        efec:   C.efectivo >= 0 ? p(totRow[C.efectivo]) : 0,
        cred:   C.credito  >= 0 ? p(totRow[C.credito])  : 0,
        deb:    C.debito   >= 0 ? p(totRow[C.debito])   : 0,
        vales:  C.vales    >= 0 ? p(totRow[C.vales])    : 0,
        mp:     C.mp       >= 0 ? p(totRow[C.mp])       : 0,
        saldo:  C.saldo    >= 0 ? p(totRow[C.saldo])    : 0,
        ops,
      };
    });

    await browser.close();
    return resultado;
  } catch (e) {
    await browser.close().catch(() => {});
    console.error(`  [${usuario}] Error: ${e.message}`);
    return null;
  }
}

async function procesarFecha(fecha_iso) {
  const rango = calcularRango(fecha_iso);
  console.log(`\n=== ${fecha_iso} | Día comercial: ${rango.label} ===`);

  const credsDoc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  const creds = credsDoc.data() || {};

  const resultados = [];
  const errores = [];

  for (const [usuario, info] of Object.entries(LOCALES_MAP)) {
    const cred = creds[usuario];
    if (!cred?.password) { console.log(`  [${info.nombre}] Sin credenciales — skip`); continue; }

    console.log(`  [${info.nombre}] leyendo DOM...`);
    const t = await descargarLocalDOM(cred.usuario || usuario, cred.password, rango);

    if (t && (t.total > 0 || t.ops === 0)) {
      const venta_real = t.total - t.saldo;
      resultados.push({
        local_id: usuario.toLowerCase(), nombre: info.nombre, ciudad: info.ciudad,
        zona: info.zona, tipo: info.tipo, venta_real,
        efectivo: t.efec, credito: t.cred, debito: t.deb,
        mercado_pago: t.mp, vales: t.vales,
        operaciones: t.ops || 0,
        ticket_prom: t.ops > 0 ? Math.round(venta_real / t.ops) : 0,
      });
      console.log(`    ✓ $${venta_real.toLocaleString('es-AR')} (${t.ops} ops)`);
    } else {
      errores.push({ usuario, nombre: info.nombre });
      console.log(`    ✗ Sin datos`);
    }
    await esperar(1000);
  }

  const ranking = [...resultados].sort((a,b) => b.venta_real - a.venta_real).map((r,i) => ({ puesto: i+1, ...r }));
  const venta_real = resultados.reduce((s,r) => s + r.venta_real, 0);
  const operaciones = resultados.reduce((s,r) => s + r.operaciones, 0);
  const ticket_prom = operaciones > 0 ? Math.round(venta_real / operaciones) : 0;

  // Detectar fecha_comercial
  const hasta = new Date(fecha_iso + 'T00:00:00');
  const desde = new Date(hasta); desde.setDate(desde.getDate() - 1);
  const fmt = d => `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`;

  const doc = {
    fecha: fecha_iso, fecha_comercial: fmt(desde), fuente: 'nucleo_dom',
    venta_real, operaciones, ticket_promedio: ticket_prom,
    locales_exitosos: resultados.length, locales_con_error: errores.length,
    errores, ranking_locales: ranking,
    propios: ranking.filter(l => l.tipo === 'propio'),
    franquicias: ranking.filter(l => l.tipo === 'franquicia'),
    descargado_at: new Date().toISOString(),
  };

  await db.collection('resumen_diario').doc(fecha_iso).set(doc);
  console.log(`\n  ✅ resumen_diario/${fecha_iso} guardado: $${venta_real.toLocaleString('es-AR')} (${resultados.length} locales)`);

  // Reconstruir resumen_mensual
  const mes = fecha_iso.slice(0, 7);
  const diasSnap = await db.collection('resumen_diario')
    .where('fecha', '>=', mes + '-01').where('fecha', '<=', mes + '-31').get();

  const acum = {};
  let diasC = 0;
  for (const d of diasSnap.docs) {
    const data = d.data();
    const locs = Array.isArray(data.ranking_locales) ? data.ranking_locales : [];
    if (locs.length === 0) continue;
    diasC++;
    for (const l of locs) {
      if (!acum[l.local_id]) acum[l.local_id] = { nombre: l.nombre, tipo: l.tipo, venta_real: 0, operaciones: 0 };
      acum[l.local_id].venta_real  += l.venta_real  || 0;
      acum[l.local_id].operaciones += l.operaciones || 0;
    }
  }
  const totalMes = Object.values(acum).reduce((s,l) => s + l.venta_real, 0);
  await db.collection('resumen_mensual').doc(mes).set({
    mes, locales: acum, venta_real_total: totalMes, dias_incluidos: diasC,
    ultima_actualizacion: new Date().toISOString(),
  });
  console.log(`✅ resumen_mensual/${mes} = $${totalMes.toLocaleString('es-AR')} (${diasC} días)`);

  return doc;
}

(async () => {
  const fechas = process.argv.slice(2);
  if (fechas.length === 0) { console.error('Uso: node redownload-dom.js 2026-08-22'); process.exit(1); }
  for (const f of fechas) await procesarFecha(f);
  process.exit(0);
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
