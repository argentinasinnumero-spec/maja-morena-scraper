'use strict';

const path = require('path');
const fs   = require('fs');

// Carpeta donde se guardan los CSV descargados de Nucleo IT
const DESCARGAS_DIR = path.join(__dirname, '..', 'descargas_nucleo');
if (!fs.existsSync(DESCARGAS_DIR)) fs.mkdirSync(DESCARGAS_DIR, { recursive: true });

// Reemplazo de page.waitForTimeout removido en Puppeteer moderno
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * CONECTOR SISTEMA NCLEO IT  MULTI-LOCAL
 * 
 * 15 locales, cada uno con usuario/contrasea propio.
 * Para cada local: login  descargar  logout  siguiente.
 *
 * HORARIO: de 7:00am del da X a 7:00am del da X+1
 *  Captura ventas despus de medianoche (locales gastronmicos)
 *
 * VENTA REAL = TOTAL - SALDO
 *  SALDO = cuenta corriente (personal/socios/desperdicios) = NO es venta real
 *
 * Portal: https://nucleoit.com.ar/NG/ClientesGastronomico/Index
 */

const { getFirestore } = require('firebase-admin/firestore');
let XLSX;
try { XLSX = require('xlsx'); } catch { XLSX = null; }

let puppeteer;
try { puppeteer = require('puppeteer'); } catch { puppeteer = null; }

const NUCLEO_BASE  = 'https://nucleoit.com.ar';
const NUCLEO_LOGIN = `${NUCLEO_BASE}/Account/LogOn?ReturnUrl=%2fNG%2fClientesGastronomico%2fIndex`;

//  Mapa definitivo de locales 
// estado: 'activo'        se scrapea normalmente (13 locales)
// estado: 'sin_sistema'   local abierto pero sin Ncleo por falta de pago  SKIP
// estado: 'cerrado'       local dado de baja  ignorar completamente
const LOCALES_MAP = {
  // ── PROPIOS activos con sistema Nucleo (9) ──────────────────────────────
  MAJAMORENA:      { nombre: 'Libertad',   ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'activo' },
  MAJASANMARTIN:   { nombre: 'San Martin', ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'activo' },
  MAJASANMARTIN58: { nombre: 'Express',    ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'activo' },
  MAJASARMIENTO:   { nombre: 'Sarmiento',  ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'activo' },
  MAJAMORENAWO:    { nombre: 'WO',         ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'activo' },
  MAJACOSQUIN:     { nombre: 'Cosquin',    ciudad: 'Cosquin',                   zona: 'cosquin',    tipo: 'franquicia', estado: 'activo' },
  MMMORTEROS:      { nombre: 'Morteros',   ciudad: 'Morteros',                  zona: 'morteros',   tipo: 'franquicia', estado: 'activo' },
  MAJARIOCUARTO:   { nombre: 'Rio Cuarto', ciudad: 'Rio Cuarto',                zona: 'rio_cuarto', tipo: 'propio',     estado: 'activo' },
  MAJACARCANO:     { nombre: 'Carcano',    ciudad: 'Carcano',                   zona: 'carcano',    tipo: 'propio',     estado: 'activo' },
  // ── FRANQUICIAS activas con sistema Nucleo (4) ──────────────────────────
  MAJAALTAGRACIA:  { nombre: 'Alta Gracia',ciudad: 'Alta Gracia',               zona: 'alta_gracia',tipo: 'franquicia', estado: 'activo' },
  MAJALOSSAUCES:   { nombre: 'Sol y Rio',  ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'franquicia', estado: 'activo' },
  MAJAMORENATANTI: { nombre: 'Tanti',      ciudad: 'Tanti',                     zona: 'tanti',      tipo: 'franquicia', estado: 'activo' },
  MAJASANTACRUZ:   { nombre: 'Santa Cruz', ciudad: 'Villa Santa Cruz del Lago', zona: 'santa_cruz', tipo: 'franquicia', estado: 'activo' },
  // ── FRANQUICIAS activas SIN sistema (falta de pago) ─────────────────────
  MAJAMORENAITALIA:     { nombre: 'Rio Cuarto Italia', ciudad: 'Rio Cuarto',  zona: 'rio_cuarto', tipo: 'franquicia', estado: 'sin_sistema', nota: 'Sin Nucleo - falta de pago' },
  MAJAMORENAMENDIOLAZA: { nombre: 'Mendiolaza',         ciudad: 'Mendiolaza', zona: 'mendiolaza', tipo: 'franquicia', estado: 'sin_sistema', nota: 'Sin Nucleo - falta de pago' },
  // ── DADOS DE BAJA ────────────────────────────────────────────────────────
  MAJATERMINAL:    { nombre: 'Terminal',   ciudad: 'Villa Carlos Paz',          zona: 'carlos_paz', tipo: 'propio',     estado: 'cerrado', nota: 'Dado de baja' },
  // Miramar y Rio Cuarto Peron - franquicias cerradas (sin usuario en Nucleo)
};

// Solo los 13 con sistema activo  estos se scrapean
const LOCALES_CON_SISTEMA = Object.entries(LOCALES_MAP)
  .filter(([, v]) => v.estado === 'activo')
  .map(([k]) => k);

//  Leer credenciales desde Firebase 
async function getCredenciales() {
  const db  = getFirestore();
  const doc = await db.collection('configuracion_central').doc('locales_nucleo').get();
  if (!doc.exists) return {};
  return doc.data() || {};
}

//  Calcular rango de fechas del da comercial 
// Para el da X: desde X 07:00 hasta X+1 07:00
function calcularRangoDia(fechaDate) {
  const desde = new Date(fechaDate);
  desde.setHours(7, 0, 0, 0);

  const hasta = new Date(fechaDate);
  hasta.setDate(hasta.getDate() + 1);
  hasta.setHours(7, 0, 0, 0);

  const fmt = (d) => {
    const dd   = String(d.getDate()).padStart(2, '0');
    const mm   = String(d.getMonth() + 1).padStart(2, '0');
    const yyyy = d.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  };

  return {
    fecha_desde:  fmt(desde),            // "11/06/2026"
    fecha_hasta:  fmt(hasta),            // "12/06/2026"
    hora_desde:   '07:00',
    hora_hasta:   '07:00',
    // El range picker de Ncleo muestra: "11/06/2026 - 12/06/2026"
    range_string: `${fmt(desde)} - ${fmt(hasta)}`,
    label:        fmt(desde),
    fecha_iso:    hasta.toISOString().split('T')[0],  // clave = fecha de fin (el día comercial real)
  };
}

//  Parsear peso argentino ($386.300,00)  nmero 
function parsearPeso(texto) {
  if (!texto) return 0;
  let s = String(texto).replace(/\$/g, '').replace(/\s/g, '').trim();
  // Formato CSV americano: "88,200.02" -> punto decimal
  if (s.includes('.') && s.includes(',')) {
    // tiene ambos -> coma es miles, punto es decimal
    s = s.replace(/,/g, '');
  } else if (s.includes(',') && !s.includes('.')) {
    // solo coma -> puede ser decimal argentino o miles
    // si hay mas de 3 digitos antes de la coma, es miles
    const partes = s.split(',');
    if (partes[1] && partes[1].length === 2) {
      s = s.replace(',', '.'); // decimal argentino
    } else {
      s = s.replace(/,/g, ''); // miles
    }
  }
  return parseFloat(s) || 0;
}

//  Login en Ncleo 
async function hacerLogin(page, usuario, password) {
  await page.goto(NUCLEO_LOGIN, { waitUntil: 'networkidle2', timeout: 30000 });
  await esperar(1000);

  const intentos = [
    { u: '#UserName',              p: '#Password' },
    { u: 'input[name="UserName"]', p: 'input[name="Password"]' },
    { u: 'input[name="usuario"]',  p: 'input[name="password"]' },
    { u: 'input[type="text"]',     p: 'input[type="password"]' },
  ];

  for (const sel of intentos) {
    try {
      await page.waitForSelector(sel.u, { timeout: 4000 });
      await page.click(sel.u, { clickCount: 3 });
      await page.type(sel.u, usuario, { delay: 50 });
      await page.click(sel.p);
      await page.type(sel.p, password, { delay: 50 });
      await page.keyboard.press('Enter');
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
      await esperar(1000);

      const hayError = await page.evaluate(() => {
        const errores = document.querySelectorAll('.field-validation-error, .alert-danger, [class*="error"]');
        return Array.from(errores).some(e => e.innerText.trim().length > 0);
      });
      if (!hayError) {
        console.log(`  [Login]  ${usuario}`);
        return true;
      }
      return false;
    } catch { /* probar siguiente selector */ }
  }
  return false;
}

//  Logout 
async function hacerLogout(page) {
  try {
    const logoutUrls = [
      `${NUCLEO_BASE}/NG/Account/Logout`,
      `${NUCLEO_BASE}/NG/ClientesGastronomico/Account/LogOff`,
      `${NUCLEO_BASE}/NG/Account/LogOff`,
    ];
    // Intentar clic en botn primero
    const sel = await page.$('a[href*="logout"], a[href*="Logout"], a[href*="LogOff"]');
    if (sel) {
      await sel.click();
      await esperar(1500);
      return;
    }
    // Ir directo a URL de logout
    for (const url of logoutUrls) {
      try {
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 8000 });
        return;
      } catch {}
    }
  } catch {}
}

//  Navegar a Historial de Pedidos 
async function navegarAHistorial(page) {
  // Intentar URLs directas
  const urls = [
    `${NUCLEO_BASE}/NG/Order/HistorialDePedidos`,
    `${NUCLEO_BASE}/NG/ClientesGastronomico/Ventas/HistorialPedidos`,
    `${NUCLEO_BASE}/NG/ClientesGastronomico/Pedidos/Historial`,
  ];
  for (const url of urls) {
    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: 10000 });
      const titulo = await page.$eval('h1, h2, .titulo', el => el.innerText).catch(() => '');
      if (titulo.toLowerCase().includes('historial') || titulo.toLowerCase().includes('pedido')) return true;
      const tieneTabla = await page.$('table').catch(() => null);
      if (tieneTabla) return true;
    } catch {}
  }

  // Navegar por men
  try {
    // Click en "Ventas" del men
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a, li'));
      const ventas = links.find(el => el.innerText.trim() === 'Ventas');
      if (ventas) ventas.click();
    });
    await esperar(800);

    // Click en "Historial de pedidos"
    await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a'));
      const hist = links.find(el => el.innerText.toLowerCase().includes('historial'));
      if (hist) hist.click();
    });
    await esperar(1500);
    return true;
  } catch {}

  return false;
}

// Flujo exacto: fecha → Aplicar → horas 07:00/07:00
async function configurarFiltros(page, rango) {
  // PASO 1: Abrir el date range picker clickeando el input de fecha
  const dateAbierto = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
    const dateInput = inputs.find(el => {
      const v = el.value || '';
      return v.match(/\d{2}[\/\-]\d{2}[\/\-]\d{4}/);
    });
    if (dateInput) { dateInput.click(); return true; }
    return false;
  });

  if (!dateAbierto) {
    // Intentar por selectores comunes
    const sels = ['#fechas','input[name="fechas"]','#daterange','.daterangepicker-input','input[class*="date"]'];
    for (const sel of sels) {
      try { await page.click(sel); break; } catch {}
    }
  }
  await esperar(800); // esperar que abra el picker

  // PASO 2: Setear fechas via jQuery daterangepicker API — reintentar hasta 5 veces
  let seteadoJQ = false;
  for (let i = 0; i < 5 && !seteadoJQ; i++) {
    seteadoJQ = await page.evaluate((desde, hasta) => {
      const $ = window.jQuery || window.$;
      if (!$) return false;
      let ok = false;
      $('input').each(function() {
        const drp = $(this).data('daterangepicker');
        if (drp) {
          drp.setStartDate(desde);
          drp.setEndDate(hasta);
          ok = true;
        }
      });
      return ok;
    }, rango.fecha_desde, rango.fecha_hasta);
    if (!seteadoJQ) await esperar(600);
  }

  if (seteadoJQ) {
    console.log(`  [Filtro] Fechas seteadas via jQuery: ${rango.fecha_desde} → ${rango.fecha_hasta}`);
  } else {
    // Fallback: click en el input y escribir la fecha manualmente
    console.warn('  [Filtro] jQuery drp no disponible, click + type manual');
    const sels = ['#fechas','input[name="fechas"]','#daterange','.daterangepicker-input'];
    for (const sel of sels) {
      try {
        await page.click(sel, { clickCount: 3 });
        await esperar(200);
        await page.keyboard.press('Control+a');
        await page.keyboard.press('Delete');
        await esperar(100);
        await page.type(sel, rango.range_string, { delay: 50 });
        await esperar(300);
        break;
      } catch {}
    }
  }

  await esperar(400);

  // PASO 3: Click en boton "Aplicar" del datepicker
  // Intentar multiples selectores — el boton puede estar oculto o en el DOM del picker
  const aplicarSels = [
    '.applyBtn',
    '.daterangepicker .applyBtn',
    '.daterangepicker button.btn-success',
    '.daterangepicker button.btn-primary',
    'button.applyBtn',
  ];
  let aplicado = false;
  for (const sel of aplicarSels) {
    try {
      await page.click(sel);
      console.log(`  [Filtro] Click Aplicar via ${sel}`);
      aplicado = true;
      break;
    } catch {}
  }
  if (!aplicado) {
    // Ultimo recurso: buscar por texto
    const clickAplicar = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('button'));
      const btn = btns.find(b => {
        const txt = (b.innerText || b.textContent || '').trim().toLowerCase();
        return txt === 'aplicar' || txt === 'apply';
      });
      if (btn) { btn.click(); return true; }
      return false;
    });
    if (clickAplicar) {
      console.log('  [Filtro] Click Aplicar via evaluate texto');
    } else {
      console.warn('  [Filtro] No se encontro boton Aplicar — continuando igual');
    }
  }
  await esperar(800);

  // PASO 4: Setear horas 07:00 → 07:00
  const setHora = async (sels, valor) => {
    for (const sel of sels) {
      try {
        const el = await page.$(sel);
        if (!el) continue;
        await page.click(sel, { clickCount: 3 });
        await esperar(100);
        await page.keyboard.press('Delete');
        await page.type(sel, valor, { delay: 50 });
        await page.keyboard.press('Tab');
        console.log(`  [Filtro] Hora ${valor} seteada en ${sel}`);
        return;
      } catch {}
    }
    // Fallback por evaluate
    await page.evaluate((sels, v) => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        if (!el) continue;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(el, v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return;
      }
    }, sels, valor);
  };

  await setHora(['#horaDesde','#HoraDesde','input[name="horaDesde"]','input[type="time"]:first-of-type'], '07:00');
  await setHora(['#horaHasta','#HoraHasta','input[name="horaHasta"]','input[type="time"]:last-of-type'],  '07:00');
  await esperar(500);
}

// Click en boton Listar y esperar tabla
async function clickListar(page) {
  const clickeado = await page.evaluate(() => {
    const todo = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"]'));
    const btn = todo.find(b => {
      const txt = (b.value || b.innerText || b.textContent || '').trim().toLowerCase();
      return txt === 'listar' || txt === 'buscar' || txt === 'filtrar';
    });
    if (btn) { btn.click(); return (btn.value || btn.innerText || '').trim(); }
    return null;
  });

  if (clickeado) {
    console.log(`  [Listar] Clickeado: "${clickeado}"`);
  } else {
    const sels = ['#btnListar','button[type="submit"]','input[type="submit"]','button.btn-primary'];
    for (const s of sels) {
      try { await page.click(s); console.log(`  [Listar] Click via ${s}`); break; } catch {}
    }
  }

  await esperar(3000);
  try { await page.waitForSelector('table tbody tr', { timeout: 10000 }); console.log('  [Listar] Tabla OK'); }
  catch { console.warn('  [Listar] Timeout tabla'); }
  await esperar(1500);
}

//  Extraer datos de la tabla resultante 
async function extraerTabla(page) {
  return await page.evaluate(() => {
    const tabla = document.querySelector('table');
    if (!tabla) return { totalizador: null, detalles: [] };

    // Indices fijos segun pantalla Nucleo IT:
    // Numero(0) Fecha(1) Cliente(2) Subtotal(3) Descuento(4) Total(5)
    // Efectivo(6) T.credito(7) T.debito(8) Vales(9) MercadoPago(10) Saldo(11) Estado(12)
    const C = { sub:3, desc:4, tot:5, efe:6, cre:7, deb:8, val:9, mp:10, sal:11 };

    const leer = (arr, i) => (i >= 0 && i < arr.length) ? (arr[i] || '0') : '0';

    const filas = Array.from(tabla.querySelectorAll('tbody tr'));
    let totalizador = null;
    const detalles = [];

    filas.forEach((fila, idx_fila) => {
      const celdas = Array.from(fila.querySelectorAll('td'));
      if (celdas.length < 4) return;
      const textos = celdas.map(c => c.innerText.replace(/\n/g, '').trim());

      if (idx_fila === 0) {
        // Primera fila siempre es el totalizador en Nucleo IT
        totalizador = {
          subtotal:     textos[C.sub]  || '0',
          descuento:    textos[C.desc] || '0',
          total:        textos[C.tot]  || '0',
          efectivo:     textos[C.efe]  || '0',
          credito:      textos[C.cre]  || '0',
          debito:       textos[C.deb]  || '0',
          vales:        textos[C.val]  || '0',
          mercado_pago: textos[C.mp]   || '0',
          saldo:        textos[C.sal]  || '0',
        };
      } else if (/^\d+$/.test(textos[0])) {
        detalles.push({
          numero:       textos[0],
          total:        leer(textos, C.tot),
          saldo:        leer(textos, C.sal),
          efectivo:     leer(textos, C.efe),
          credito:      leer(textos, C.cre),
          debito:       leer(textos, C.deb),
          vales:        leer(textos, C.val),
          mercado_pago: leer(textos, C.mp),
          estado:       leer(textos, 12),
        });
      }
    });
    return { totalizador, detalles };
  });
}

// Descarga directa via endpoint ExportSalesHistory con fechas correctas del dia comercial
async function descargarExportDirecto(page, usuario, rango) {
  try {
    // Dia comercial: fechaDesde 07:00 ART → fechaHasta 07:00 ART
    // ART = UTC-3, entonces 07:00 ART = 10:00 UTC
    const [dd1, mm1, yyyy1] = rango.fecha_desde.split('/');
    const [dd2, mm2, yyyy2] = rango.fecha_hasta.split('/');
    const startDate  = `${yyyy1}-${mm1}-${dd1}`;
    const endDate    = `${yyyy2}-${mm2}-${dd2}`;
    const startTime  = `${startDate}T10:00:00.000Z`; // 07:00 ART
    const endTime    = `${endDate}T09:59:00.000Z`;   // 06:59 ART

    const exportUrl = `${NUCLEO_BASE}/NG/Order/ExportSalesHistory?ActivationState=0&Branches=1&CustomerId=0` +
      `&EndDate=${endDate}&EndTime=${encodeURIComponent(endTime)}` +
      `&FiltroDePedido=0&SaleChannels=0&ShowMercadoPago=true&ShowNumberIntegration=false&ShowRappi=false` +
      `&StartDate=${startDate}&StartTime=${encodeURIComponent(startTime)}&TimeFilter=1`;

    console.log(`  [Export] URL: ${startDate} 07hs ART → ${endDate} 07hs ART`);

    // Descargar usando fetch con las cookies de sesion activas (ya estamos logueados)
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

    if (buffer.error) {
      console.warn(`  [Export] Error fetch: ${buffer.error}`);
      return null;
    }

    const nombreArchivo = `${usuario}_${rango.fecha_iso}.xlsx`;
    const rutaArchivo   = path.join(DESCARGAS_DIR, nombreArchivo);
    fs.writeFileSync(rutaArchivo, Buffer.from(buffer.data));
    console.log(`  [Export] Guardado: ${nombreArchivo} (${buffer.data.length} bytes)`);
    return rutaArchivo;

  } catch (e) {
    console.error(`  [Export] Error para ${usuario}:`, e.message);
    return null;
  }
}

// Funcion principal: setear fecha, listar y exportar, interceptando requests para obtener la URL real
async function descargarConFechaCorrecta(page, usuario, rango) {
  try {
    const archivosAntes = fs.readdirSync(DESCARGAS_DIR);

    // 1. Configurar CDP para downloads
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: DESCARGAS_DIR });

    // 2. Activar intercepcion de requests para capturar el endpoint de Listar y Exportar
    let listarUrl   = null;
    let listarMethod = 'GET';
    let listarHeaders = {};
    let listarBody  = null;
    let exportarUrl = null;

    await page.setRequestInterception(true);
    const requestHandler = (req) => {
      const url = req.url();
      const method = req.method();
      // Capturar request de Listar (busqueda/filtro)
      if (!listarUrl && (url.includes('Historial') || url.includes('historial') || url.includes('listar') || url.includes('Listar') || url.includes('Order')) && method !== 'GET') {
        listarUrl    = url;
        listarMethod = method;
        listarBody   = req.postData();
        listarHeaders = req.headers();
        console.log(`  [Net] Listar capturado: ${method} ${url}`);
        if (listarBody) console.log(`  [Net] Body: ${listarBody.substring(0, 200)}`);
      }
      // Capturar request de Exportar
      if (!exportarUrl && (url.includes('xport') || url.includes('xls') || url.includes('csv') || url.includes('Export') || url.includes('Descargar'))) {
        exportarUrl = url;
        console.log(`  [Net] Exportar capturado: ${url}`);
      }
      req.continue();
    };
    page.on('request', requestHandler);

    // 3. Intentar setear la fecha de todas las formas posibles
    // Metodo A: jQuery daterangepicker API
    const fechaOkJQ = await page.evaluate((desde, hasta, rangeStr) => {
      const $ = window.jQuery || window.$;
      if (!$) return false;
      const inputs = $('input');
      let seteado = false;
      inputs.each(function() {
        const drp = $(this).data('daterangepicker');
        if (drp) {
          drp.setStartDate(desde);
          drp.setEndDate(hasta);
          $(this).val(rangeStr).trigger('change').trigger('apply.daterangepicker');
          seteado = true;
        }
      });
      return seteado;
    }, rango.fecha_desde, rango.fecha_hasta, rango.range_string);

    if (fechaOkJQ) {
      console.log('  [Filtro] Fecha seteada via jQuery daterangepicker');
    } else {
      // Metodo B: click real en el input + typing
      const dateSelectors = [
        '#fechas', 'input[name="fechas"]', '#daterange', '#FechaDesde',
        '.daterangepicker-input', 'input[class*="date"]',
        'input[placeholder*="echa"]',
      ];
      let seteado = false;
      for (const sel of dateSelectors) {
        try {
          const el = await page.$(sel);
          if (!el) continue;
          await page.click(sel, { clickCount: 3 });
          await esperar(300);
          await page.keyboard.down('Control');
          await page.keyboard.press('a');
          await page.keyboard.up('Control');
          await page.keyboard.press('Delete');
          await esperar(200);
          await page.type(sel, rango.range_string, { delay: 50 });
          await esperar(300);
          await page.keyboard.press('Escape');
          await esperar(300);
          console.log(`  [Filtro] Fecha seteada via selector: ${sel}`);
          seteado = true;
          break;
        } catch {}
      }
      if (!seteado) {
        // Metodo C: buscar el primer input de texto con fecha y escribir
        await page.evaluate((rangeStr) => {
          const inputs = Array.from(document.querySelectorAll('input[type="text"], input:not([type])'));
          const dateInput = inputs.find(el => el.value && el.value.match(/\d{2}[\/\-]\d{2}[\/\-]\d{4}/));
          if (dateInput) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
            nativeSetter.call(dateInput, rangeStr);
            dateInput.dispatchEvent(new Event('input', { bubbles: true }));
            dateInput.dispatchEvent(new Event('change', { bubbles: true }));
          }
        }, rango.range_string);
      }
    }

    await esperar(500);

    // 4. Click en boton Listar
    const listarClickeado = await page.evaluate(() => {
      const todo = Array.from(document.querySelectorAll('button, input[type="submit"], input[type="button"], a.btn'));
      const btn = todo.find(b => {
        const txt = (b.value || b.innerText || b.textContent || '').trim().toLowerCase();
        return txt === 'listar' || txt === 'buscar' || txt === 'filtrar' || txt === 'consultar';
      });
      if (btn) { btn.click(); return (btn.value || btn.innerText || '').trim(); }
      return null;
    });
    if (listarClickeado) {
      console.log(`  [Listar] Clickeado: "${listarClickeado}"`);
    } else {
      const listarSels = ['#btnListar','button[type="submit"]','input[type="submit"]','button.btn-primary'];
      for (const s of listarSels) {
        try { await page.click(s); console.log(`  [Listar] Click via: ${s}`); break; } catch {}
      }
    }

    // Esperar tabla
    await esperar(3000);
    try { await page.waitForSelector('table tbody tr', { timeout: 8000 }); } catch {}
    await esperar(1000);

    // 5. Click en boton Exportar y esperar el archivo
    await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button, input[type="button"]'));
      const exp = btns.find(b => (b.innerText || b.textContent || b.value || '').toLowerCase().includes('exportar'));
      if (exp) exp.click();
    });

    // 6. Esperar archivo en disco (20 seg)
    let archivoNuevo = null;
    for (let i = 0; i < 40; i++) {
      await esperar(500);
      const archivosAhora = fs.readdirSync(DESCARGAS_DIR);
      const nuevo = archivosAhora.find(f =>
        !archivosAntes.includes(f) &&
        (f.endsWith('.csv') || f.endsWith('.xlsx') || f.endsWith('.xls')) &&
        !f.endsWith('.crdownload') && !f.endsWith('.tmp')
      );
      if (nuevo) { archivoNuevo = nuevo; break; }
    }

    page.off('request', requestHandler);
    await page.setRequestInterception(false).catch(() => {});

    if (archivoNuevo) {
      const ruta = path.join(DESCARGAS_DIR, archivoNuevo);
      console.log(`  [Export] Archivo: ${archivoNuevo} (${fs.statSync(ruta).size} bytes)`);

      // Si capturamos la URL de Listar y tiene params de fecha, loguear para diagnostico
      if (listarUrl && listarBody) {
        console.log(`  [Diag] Listar URL: ${listarUrl}`);
      }
      return ruta;
    }

    console.warn(`  [Export] No aparecio archivo para ${usuario}`);
    if (exportarUrl) console.warn(`  [Export] URL capturada: ${exportarUrl}`);
    return null;

  } catch (e) {
    console.error(`  [Export] Error para ${usuario}:`, e.message);
    try { await page.setRequestInterception(false); } catch {}
    return null;
  }
}

// Descargar CSV via boton "Exportar reporte"
// El CSV se descarga como archivo al disco; lo leemos desde DESCARGAS_DIR
async function descargarCSV(page, usuario, fecha) {
  try {
    // 1. Configurar carpeta de descarga via CDP
    const client = await page.createCDPSession();
    await client.send('Page.setDownloadBehavior', {
      behavior: 'allow',
      downloadPath: DESCARGAS_DIR,
    });

    // 2. Obtener lista de archivos ANTES del click para detectar el nuevo
    const archivosAntes = fs.readdirSync(DESCARGAS_DIR);

    // 3. Intentar fetch directo si el boton es un <a href="...">
    const csvUrl = await page.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('a, button'));
      const exportBtn = btns.find(b =>
        (b.innerText || b.textContent || b.value || '').toLowerCase().includes('exportar') ||
        (b.href || '').toLowerCase().includes('export') ||
        (b.href || '').toLowerCase().includes('csv')
      );
      if (!exportBtn) return null;
      const href = exportBtn.href || '';
      // Solo devolver si es una URL real (no javascript:void)
      return href && !href.startsWith('javascript') ? href : null;
    });

    if (csvUrl && csvUrl.startsWith('http')) {
      // Intentar fetch y guardar como archivo
      const cookies = await page.cookies();
      const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');
      const buffer = await page.evaluate(async (url, ck) => {
        try {
          const r = await fetch(url, { headers: { 'Cookie': ck }, credentials: 'include' });
          if (r.ok) {
            const ab = await r.arrayBuffer();
            return Array.from(new Uint8Array(ab));
          }
        } catch {}
        return null;
      }, csvUrl, cookieStr);
      if (buffer && buffer.length > 50) {
        const rutaFetch = path.join(DESCARGAS_DIR, `fetch_${usuario}_${Date.now()}.xlsx`);
        fs.writeFileSync(rutaFetch, Buffer.from(buffer));
        console.log(`  [CSV] Descargado via fetch (${buffer.length} bytes) para ${usuario}`);
        return rutaFetch;
      }
    }

    // 4. Click en el boton "Exportar reporte" — esperar que aparezca si la tabla tarda
    let exportClickeado = false;
    for (let intento = 0; intento < 6; intento++) {
      exportClickeado = await page.evaluate(() => {
        const btns = Array.from(document.querySelectorAll('a, button, input[type="button"], input[type="submit"]'));
        const exportBtn = btns.find(b =>
          (b.innerText || b.textContent || b.value || '').toLowerCase().includes('exportar')
        );
        if (exportBtn) { exportBtn.click(); return true; }
        return false;
      });
      if (exportClickeado) { console.log(`  [CSV] Click Exportar OK`); break; }
      await esperar(1000); // esperar 1 seg mas y reintentar
    }
    if (!exportClickeado) console.warn(`  [CSV] No se encontro boton Exportar reporte`);

    // 5. Esperar hasta 20 segundos a que aparezca un archivo nuevo en el disco
    let archivoNuevo = null;
    for (let i = 0; i < 40; i++) {
      await esperar(500);
      const archivosAhora = fs.readdirSync(DESCARGAS_DIR);
      const nuevo = archivosAhora.find(f =>
        !archivosAntes.includes(f) &&
        (f.endsWith('.csv') || f.endsWith('.txt') || f.endsWith('.xls') || f.endsWith('.xlsx')) &&
        !f.endsWith('.crdownload') && !f.endsWith('.tmp')
      );
      if (nuevo) { archivoNuevo = nuevo; break; }
    }

    if (archivoNuevo) {
      const rutaArchivo = path.join(DESCARGAS_DIR, archivoNuevo);
      const stat = fs.statSync(rutaArchivo);
      console.log(`  [CSV] Archivo descargado: ${archivoNuevo} (${stat.size} bytes) para ${usuario}`);
      return rutaArchivo;
    }

    console.warn(`  [CSV] No se encontro boton exportar ni archivo descargado para ${usuario}`);
    return null;
  } catch (e) {
    console.error(`  [CSV] Error en descargarCSV para ${usuario}:`, e.message);
    return null;
  }
}

// Parsear el archivo descargado de Nucleo IT (XLSX o CSV)
// Columnas: Sucursal Numero NumInteg Fecha Subtotal Descuento Total Efectivo TCredito TDebito Vales MercadoPago Saldo Estado
// La ultima fila sin Numero es el totalizador
// rango: objeto con fecha_desde, fecha_hasta, hora_desde, hora_hasta para filtrar por dia comercial
function parsearArchivoNucleo(rutaArchivo, rango) {
  // Parsear numero en formato "$ 88,200.02" o 88200.02 -> numero
  const parseNum = (s) => {
    if (s === null || s === undefined || s === '') return 0;
    if (typeof s === 'number') return s;
    return parseFloat(String(s).replace(/\$/g,'').replace(/,/g,'').trim()) || 0;
  };

  let filas = []; // array de arrays (cada fila es un array de celdas)

  const ext = path.extname(rutaArchivo).toLowerCase();

  if ((ext === '.xlsx' || ext === '.xls') && XLSX) {
    const wb = XLSX.readFile(rutaArchivo);
    const ws = wb.Sheets[wb.SheetNames[0]];
    // sheet_to_json con header:1 devuelve array de arrays
    filas = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  } else {
    // Leer como texto (CSV o TSV)
    const texto = fs.readFileSync(rutaArchivo, 'utf8');
    const sep = texto.includes('\t') ? '\t' : ',';
    filas = texto.split('\n')
      .map(l => l.trim())
      .filter(l => l.length > 0)
      .map(l => l.split(sep));
  }

  if (filas.length < 2) {
    console.warn('  [CSV] Archivo con menos de 2 filas:', rutaArchivo);
    return { totalizador: null, detalles: [] };
  }

  // Detectar indices de columnas buscando el header
  // Header esperado: Sucursal Numero NumInteg Fecha Subtotal Descuento Total Efectivo T.credito T.debito Vales MercadoPago Saldo Estado
  const header = filas[0].map(c => String(c).toLowerCase().trim());
  const col = (nombres) => {
    for (const n of nombres) {
      const idx = header.findIndex(h => h.includes(n));
      if (idx >= 0) return idx;
    }
    return -1;
  };

  const C = {
    numero:      col(['numero', 'nro', 'num']),
    fecha:       col(['fecha']),
    subtotal:    col(['subtotal']),
    descuento:   col(['descuento', 'desc']),
    total:       col(['total']),
    efectivo:    col(['efectivo', 'efect']),
    credito:     col(['credito', 'crédito', 'tcredito', 't.cr']),
    debito:      col(['debito', 'débito', 'tdebito', 't.d']),
    vales:       col(['vales', 'vale']),
    mercado_pago:col(['mercado', 'mp']),
    saldo:       col(['saldo']),
    estado:      col(['estado']),
  };

  // Fallback a indices fijos si no encontro por nombre
  // Sucursal(0) Numero(1) NumInteg(2) Fecha(3) Subtotal(4) Descuento(5) Total(6) Efectivo(7) Credito(8) Debito(9) Vales(10) MercadoPago(11) Saldo(12) Estado(13)
  if (C.numero < 0)      C.numero      = 1;
  if (C.fecha < 0)       C.fecha       = 3;
  if (C.subtotal < 0)    C.subtotal    = 4;
  if (C.descuento < 0)   C.descuento   = 5;
  if (C.total < 0)       C.total       = 6;
  if (C.efectivo < 0)    C.efectivo    = 7;
  if (C.credito < 0)     C.credito     = 8;
  if (C.debito < 0)      C.debito      = 9;
  if (C.vales < 0)       C.vales       = 10;
  if (C.mercado_pago < 0)C.mercado_pago= 11;
  if (C.saldo < 0)       C.saldo       = 12;
  if (C.estado < 0)      C.estado      = 13;

  const detalles = [];
  let totalizador = null;

  for (let i = 1; i < filas.length; i++) {
    const cols = filas[i];
    if (!cols || cols.length < 4) continue;

    const numero = String(cols[C.numero] || '').trim();
    const esTotal = !numero || numero === '';

    if (esTotal) {
      totalizador = {
        subtotal:     cols[C.subtotal]    || '0',
        descuento:    cols[C.descuento]   || '0',
        total:        cols[C.total]       || '0',
        efectivo:     cols[C.efectivo]    || '0',
        credito:      cols[C.credito]     || '0',
        debito:       cols[C.debito]      || '0',
        vales:        cols[C.vales]       || '0',
        mercado_pago: cols[C.mercado_pago]|| '0',
        saldo:        cols[C.saldo]       || '0',
      };
    } else {
      detalles.push({
        numero,
        fecha:        String(cols[C.fecha]       || ''),
        total:        parseNum(cols[C.total]),
        saldo:        parseNum(cols[C.saldo]),
        efectivo:     parseNum(cols[C.efectivo]),
        credito:      parseNum(cols[C.credito]),
        debito:       parseNum(cols[C.debito]),
        vales:        parseNum(cols[C.vales]),
        mercado_pago: parseNum(cols[C.mercado_pago]),
        estado:       String(cols[C.estado] || ''),
      });
    }
  }

  if (!totalizador && detalles.length > 0) {
    // Si no hay fila totalizadora, sumar manualmente
    console.warn('  [CSV] Sin fila totalizadora, calculando suma manual');
    const suma = (campo) => detalles.reduce((a, d) => a + (d[campo] || 0), 0);
    totalizador = {
      subtotal:     String(suma('total')),
      descuento:    '0',
      total:        String(suma('total')),
      efectivo:     String(suma('efectivo')),
      credito:      String(suma('credito')),
      debito:       String(suma('debito')),
      vales:        String(suma('vales')),
      mercado_pago: String(suma('mercado_pago')),
      saldo:        String(suma('saldo')),
    };
  }

  // Nucleo IT ya filtra por fecha y hora (07:00 a 07:00) cuando se configura correctamente.
  // Usamos el totalizador del XLSX directamente — es la fuente de verdad.
  // Los detalles son solo para contar operaciones y calcular ticket promedio.
  console.log(`  [CSV] Filas: ${filas.length-1} | Pedidos: ${detalles.length} | Totalizador: ${totalizador ? 'SI' : 'NO'}`);
  return { totalizador, detalles, parseNum };
}

//  Scraper de UN local
async function scrapearLocal(browser, usuario, password, rango) {
  try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36');

  try {
    const loginOk = await hacerLogin(page, usuario, password);
    if (!loginOk) {
      await page.close();
      return { error: `Login fallido para ${usuario}  verificar contrasea en Configuracin`, exito: false };
    }

    // Intentar endpoint directo primero (más confiable que jQuery UI)
    let rutaArchivo = await descargarExportDirecto(page, usuario, rango);

    // Fallback: UI con jQuery solo si el endpoint directo falló
    if (!rutaArchivo) {
      console.warn(`  [${usuario}] Endpoint directo falló, intentando via UI...`);
      await navegarAHistorial(page);
      await esperar(2000);
      await configurarFiltros(page, rango);
      await clickListar(page);
      rutaArchivo = await descargarCSV(page, usuario, rango.fecha_iso);
    }
    await hacerLogout(page);
    await page.close();

    if (!rutaArchivo) {
      return { error: `Sin datos para ${usuario} (puede ser que no haya ventas ese dia)`, exito: false, usuario, detalles: [] };
    }

    const { totalizador, detalles } = parsearArchivoNucleo(rutaArchivo, rango);

    const total      = parsearPeso(totalizador.total);
    const saldo      = parsearPeso(totalizador.saldo);
    const venta_real = total - saldo;
    const info       = LOCALES_MAP[usuario] || { nombre: usuario, ciudad: 'Desconocida', zona: 'desconocida' };

    return {
      exito:    true,
      usuario,
      local_id: usuario.toLowerCase(),
      nombre:   info.nombre,
      ciudad:   info.ciudad,
      zona:     info.zona,
      tipo:     info.tipo || 'propio',
      subtotal:    parsearPeso(totalizador.subtotal),
      descuento:   parsearPeso(totalizador.descuento),
      total_bruto: total,
      saldo_cc:    saldo,
      venta_real,
      formas_pago: {
        efectivo:    parsearPeso(totalizador.efectivo),
        credito:     parsearPeso(totalizador.credito),
        debito:      parsearPeso(totalizador.debito),
        vales:       parsearPeso(totalizador.vales),
        mercado_pago: parsearPeso(totalizador.mercado_pago),
      },
      cantidad_operaciones: detalles.length,
      ticket_promedio: detalles.length > 0 && venta_real > 0
        ? Math.round(venta_real / detalles.length) : 0,
      detalle_pedidos: detalles.map(d => ({
        numero:      d.numero,
        fecha:       d.fecha       || '',
        cliente:     d.cliente     || '',
        total:       parsearPeso(d.total),
        saldo:       parsearPeso(d.saldo),
        venta_real:  parsearPeso(d.total) - parsearPeso(d.saldo),
        efectivo:    parsearPeso(d.efectivo),
        credito:     parsearPeso(d.credito),
        debito:      parsearPeso(d.debito),
        vales:       parsearPeso(d.vales),
        mercado_pago: parsearPeso(d.mercado_pago),
        estado:      d.estado      || '',
      })),
    };
  } catch (e) {
    await page.close().catch(() => {});
    return { error: e.message, exito: false, usuario };
  }
  } catch (e) {
    // browser.newPage() falló (browser caído)
    return { error: e.message, exito: false, usuario };
  }
}

//  Scraper principal: TODOS los locales 
async function scrapearTodosLosLocales(fechaDate, credenciales) {
  if (!puppeteer) throw new Error('Puppeteer no disponible.');

  const rango    = calcularRangoDia(fechaDate);
  // Solo scrapear los 13 activos CON sistema (excluye sin_sistema y cerrados)
  const usuarios = LOCALES_CON_SISTEMA.filter(u => credenciales[u]?.password);

  console.log(`\n[Ncleo] `);
  console.log(`[Ncleo] Da comercial: ${rango.label}  |  ${rango.range_string}  07:00  07:00`);
  console.log(`[Ncleo] Locales a procesar: ${usuarios.length} de ${Object.keys(LOCALES_MAP).length}`);
  console.log(`[Ncleo] \n`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    downloadsPath: DESCARGAS_DIR,
  });

  const resultados = [];
  const errores    = [];

  for (const usuario of usuarios) {
    const password = credenciales[usuario].password;
    const infoLocal = LOCALES_MAP[usuario];
    console.log(`[Ncleo]  ${usuario.padEnd(25)}  ${infoLocal.nombre}`);

    const resultado = await scrapearLocal(browser, usuario, password, rango);

    if (resultado.exito) {
      resultados.push(resultado);
      const v = resultado.venta_real.toLocaleString('es-AR');
      const o = resultado.cantidad_operaciones;
      console.log(`[Ncleo]  ${resultado.nombre.padEnd(30)} $${v.padStart(12)}  (${o} operaciones)`);
    } else {
      errores.push({ usuario, error: resultado.error });
      console.warn(`[Ncleo]  ${usuario}: ${resultado.error}`);
    }

    // Pausa entre locales para no sobrecargar el servidor
    await new Promise(r => setTimeout(r, 1500));
  }

  await browser.close();

  //  Consolidar totales: RED COMPLETA + PROPIOS + FRANQUICIAS
  const sumarGrupo = (lista) => lista.reduce((acc, r) => ({
    venta_real:           acc.venta_real           + r.venta_real,
    total_bruto:          acc.total_bruto          + r.total_bruto,
    saldo_cc:             acc.saldo_cc             + r.saldo_cc,
    cantidad_operaciones: acc.cantidad_operaciones + r.cantidad_operaciones,
    efectivo:             acc.efectivo             + r.formas_pago.efectivo,
    credito:              acc.credito              + r.formas_pago.credito,
    debito:               acc.debito               + r.formas_pago.debito,
    vales:                acc.vales                + r.formas_pago.vales,
    mercado_pago:         acc.mercado_pago         + r.formas_pago.mercado_pago,
  }), { venta_real:0, total_bruto:0, saldo_cc:0, cantidad_operaciones:0, efectivo:0, credito:0, debito:0, vales:0, mercado_pago:0 });

  const totales    = sumarGrupo(resultados);
  const propios    = sumarGrupo(resultados.filter(r => r.tipo === 'propio'));
  const franquicias= sumarGrupo(resultados.filter(r => r.tipo === 'franquicia'));

  const ticket_promedio_red = totales.cantidad_operaciones > 0
    ? Math.round(totales.venta_real / totales.cantidad_operaciones) : 0;

  // Ranking por venta real (incluye formas_pago y tipo para reporte detallado)
  const ranking_locales = [...resultados]
    .sort((a, b) => b.venta_real - a.venta_real)
    .map((r, i) => ({
      puesto:      i + 1,
      local_id:    r.local_id,
      nombre:      r.nombre,
      ciudad:      r.ciudad,
      tipo:        r.tipo,
      venta_real:  r.venta_real,
      operaciones: r.cantidad_operaciones,
      ticket_prom: r.ticket_promedio,
      efectivo:    r.formas_pago.efectivo,
      credito:     r.formas_pago.credito,
      debito:      r.formas_pago.debito,
      mercado_pago: r.formas_pago.mercado_pago,
      vales:       r.formas_pago.vales,
    }));

  // Agrupacin por ciudad
  const por_ciudad = {};
  for (const r of resultados) {
    if (!por_ciudad[r.ciudad]) por_ciudad[r.ciudad] = { venta_real:0, operaciones:0, locales:0 };
    por_ciudad[r.ciudad].venta_real  += r.venta_real;
    por_ciudad[r.ciudad].operaciones += r.cantidad_operaciones;
    por_ciudad[r.ciudad].locales     += 1;
  }

  console.log(`\n[Ncleo] ────────────────────────────────────────`);
  console.log(`[Ncleo] TOTAL RED:         $${totales.venta_real.toLocaleString('es-AR')}`);
  console.log(`[Ncleo] ├─ Propios (${resultados.filter(r=>r.tipo==='propio').length}):     $${propios.venta_real.toLocaleString('es-AR')}`);
  console.log(`[Ncleo] └─ Franquicias (${resultados.filter(r=>r.tipo==='franquicia').length}): $${franquicias.venta_real.toLocaleString('es-AR')}`);
  console.log(`[Ncleo] Locales OK: ${resultados.length}  |  Errores: ${errores.length}`);
  console.log(`[Ncleo] ────────────────────────────────────────\n`);

  return {
    fecha_comercial:      rango.label,
    fecha_iso:            rango.fecha_iso,
    rango_desde:          `${rango.fecha_desde} ${rango.hora_desde}`,
    rango_hasta:          `${rango.fecha_hasta} ${rango.hora_hasta}`,
    // Totales red completa
    venta_real:           totales.venta_real,
    total_bruto:          totales.total_bruto,
    saldo_cc:             totales.saldo_cc,
    cantidad_operaciones: totales.cantidad_operaciones,
    ticket_promedio:      ticket_promedio_red,
    formas_pago: {
      efectivo:     totales.efectivo,
      credito:      totales.credito,
      debito:       totales.debito,
      vales:        totales.vales,
      mercado_pago: totales.mercado_pago,
    },
    // Desglose por tipo
    propios: {
      venta_real:           propios.venta_real,
      total_bruto:          propios.total_bruto,
      saldo_cc:             propios.saldo_cc,
      cantidad_operaciones: propios.cantidad_operaciones,
      formas_pago: { efectivo: propios.efectivo, credito: propios.credito, debito: propios.debito, vales: propios.vales, mercado_pago: propios.mercado_pago },
    },
    franquicias: {
      venta_real:           franquicias.venta_real,
      total_bruto:          franquicias.total_bruto,
      saldo_cc:             franquicias.saldo_cc,
      cantidad_operaciones: franquicias.cantidad_operaciones,
      formas_pago: { efectivo: franquicias.efectivo, credito: franquicias.credito, debito: franquicias.debito, vales: franquicias.vales, mercado_pago: franquicias.mercado_pago },
    },
    // Desglose
    ranking_locales,
    por_ciudad,
    detalle_por_local: resultados,
    // Estado
    locales_exitosos:  resultados.length,
    locales_con_error: errores.length,
    errores:           errores.length > 0 ? errores : [],
    descargado_at:     new Date(),
    fuente:            'nucleo_it_automatico',
    exito:             true,
  };
}

//  Guardar en Firebase
async function guardarEnFirebase(datos) {
  const db    = getFirestore();
  const fecha = datos.fecha_iso;

  // Documento completo (incluye detalle por local)
  await db.collection('ventas_nucleo').doc(fecha).set(datos, { merge: true });

  // Resumen consolidado (para dashboard y agentes)
  await db.collection('resumen_diario').doc(fecha).set({
    fecha:                fecha,
    fecha_comercial:      datos.fecha_comercial,
    venta_real:           datos.venta_real,
    venta_total_bruta:    datos.total_bruto,
    saldo_cc:             datos.saldo_cc,
    cantidad_operaciones: datos.cantidad_operaciones,
    ticket_promedio:      datos.ticket_promedio,
    formas_pago:          datos.formas_pago,
    ranking_locales:      datos.ranking_locales,
    por_ciudad:           datos.por_ciudad,
    propios:              datos.propios,
    franquicias:          datos.franquicias,
    locales_exitosos:     datos.locales_exitosos,
    locales_con_error:    datos.locales_con_error,
    descargado_at:        datos.descargado_at,
    fuente:               'nucleo_it',
  }, { merge: true });

  // Detalle por local (coleccin separada para histrico)
  if (datos.detalle_por_local?.length) {
    const BATCH_SIZE = 10;
    for (let i = 0; i < datos.detalle_por_local.length; i += BATCH_SIZE) {
      const batch = db.batch();
      const chunk = datos.detalle_por_local.slice(i, i + BATCH_SIZE);
      for (const local of chunk) {
        const ref = db.collection('ventas_nucleo_por_local').doc(`${fecha}_${local.local_id}`);
        batch.set(ref, {
          ...local,
          fecha_iso:       fecha,
          fecha_comercial: datos.fecha_comercial,
          descargado_at:   datos.descargado_at,
        }, { merge: true });
      }
      await batch.commit();
    }
  }

  // Acumulado mensual: reconstruir desde cero sumando todos los resumen_diario del mes
  const mesKey = fecha.slice(0, 7); // "2026-07"
  const mesRef = db.collection('resumen_mensual').doc(mesKey);

  const [mesYear, mesMonth] = mesKey.split('-');
  // El doc del día 1 contiene el día comercial del mes anterior → empezar desde el día 2
  // El día comercial de hoy (fecha) se acaba de guardar arriba → incluirlo con fecha <= fecha
  const primerDia = `${mesYear}-${mesMonth}-02`;
  const diasSnap = await db.collection('resumen_diario')
    .where('fecha', '>=', primerDia)
    .where('fecha', '<=', fecha)
    .get();

  const localesMes = {};
  const diasIncluidos = [];

  for (const doc of diasSnap.docs) {
    const d = doc.data();
    diasIncluidos.push(doc.id);
    for (const r of (d.ranking_locales || [])) {
      const lid = r.local_id;
      if (!lid) continue;
      if (!localesMes[lid]) {
        localesMes[lid] = { nombre: r.nombre, tipo: r.tipo, venta_real: 0, efectivo: 0, credito: 0, debito: 0, mercado_pago: 0, vales: 0, operaciones: 0 };
      }
      localesMes[lid].venta_real   += r.venta_real   || 0;
      localesMes[lid].efectivo     += r.efectivo      || 0;
      localesMes[lid].credito      += r.credito       || 0;
      localesMes[lid].debito       += r.debito        || 0;
      localesMes[lid].mercado_pago += r.mercado_pago  || 0;
      localesMes[lid].vales        += r.vales         || 0;
      localesMes[lid].operaciones  += r.operaciones   || 0;
    }
  }

  const venta_real_total = Object.values(localesMes).reduce((s, l) => s + l.venta_real, 0);
  await mesRef.set({
    mes: mesKey,
    locales: localesMes,
    dias_incluidos: diasIncluidos.sort(),
    ultima_actualizacion: new Date(),
    venta_real_total,
  });
  console.log(`[Ncleo]  Acumulado mensual reconstruido: resumen_mensual/${mesKey} (${diasIncluidos.length} días | $${venta_real_total.toLocaleString('es-AR')})`);


  console.log(`[Ncleo]  Guardado: ventas_nucleo/${fecha}  +  ${datos.detalle_por_local?.length || 0} docs por local`);

  // Subir los Excel al sistema de estadísticas via Importador POS
  try {
    const { subirArchivosDelDia } = require('./subirAEstadisticas');
    const res = await subirArchivosDelDia(fecha);
    if (res.exito) {
      console.log(`[Ncleo]  ${res.archivos} archivos subidos al sistema de estadísticas OK`);
    } else {
      console.warn(`[Ncleo]  Error subiendo a estadísticas: ${res.error}`);
    }
  } catch (e) {
    console.warn('[Ncleo]  No se pudo subir a estadísticas (no crítico):', e.message);
  }
}

//  API pblica 

/**
 * Descarga ventas de todos los locales para el da comercial de HOY.
 * Lgica gastronmica: "hoy" = ayer 7am  hoy 7am
 */
async function ejecutarDescargaDiaria() {
  console.log('[Ncleo] Iniciando descarga diaria de todos los locales...');

  const credenciales = await getCredenciales();
  const conPass      = Object.keys(LOCALES_MAP).filter(u => credenciales[u]?.password);

  if (conPass.length === 0) {
    return {
      exito: false,
      error: 'Sin credenciales configuradas. Ir a MENTE MAESTRA  Configuracin  Locales Ncleo IT.',
      requiere_configuracion: true,
    };
  }

  const hoy          = new Date();
  const diaComercial = new Date(hoy);
  // Si son antes de las 7am el da comercial activo es el de anteayer
  if (hoy.getHours() < 7) {
    diaComercial.setDate(diaComercial.getDate() - 2);
  } else {
    diaComercial.setDate(diaComercial.getDate() - 1);
  }

  try {
    const datos = await scrapearTodosLosLocales(diaComercial, credenciales);
    await guardarEnFirebase(datos);

    // Actualizar estado de ltima descarga
    const db = getFirestore();
    await db.collection('configuracion_central').doc('locales_nucleo').set({
      ultimo_exito:          new Date(),
      ultimo_dia_bajado:     datos.fecha_comercial,
      ultima_venta_real_red: datos.venta_real,
      locales_configurados:  conPass.length,
    }, { merge: true });

    return datos;
  } catch (e) {
    console.error('[Ncleo]  Error:', e.message);
    const db = getFirestore();
    await db.collection('configuracion_central').doc('locales_nucleo').set({
      ultimo_error: new Date(), error_mensaje: e.message,
    }, { merge: true });
    return { exito: false, error: e.message };
  }
}

/**
 * Descarga para una fecha especfica
 */
async function descargarFechaEspecifica(fechaStr) {
  const credenciales = await getCredenciales();
  let fecha;
  if (fechaStr.includes('/')) {
    const [dd, mm, yyyy] = fechaStr.split('/');
    fecha = new Date(Number(yyyy), Number(mm) - 1, Number(dd));
  } else {
    fecha = new Date(fechaStr);
  }
  const datos = await scrapearTodosLosLocales(fecha, credenciales);
  await guardarEnFirebase(datos);
  return datos;
}

/**
 * Estado de la configuracin
 */
async function verificarConexion() {
  try {
    const credenciales     = await getCredenciales();
    const configurados     = Object.keys(LOCALES_MAP).filter(u => credenciales[u]?.password);
    const faltantes        = Object.keys(LOCALES_MAP).filter(u => !credenciales[u]?.password);
    return {
      configurado:           configurados.length > 0,
      locales_totales:       Object.keys(LOCALES_MAP).length,
      locales_configurados:  configurados.length,
      locales_faltantes:     faltantes,
      ultimo_exito:          credenciales.ultimo_exito,
      ultimo_error:          credenciales.ultimo_error,
    };
  } catch {
    return { configurado: false };
  }
}

module.exports = {
  ejecutarDescargaDiaria,
  descargarFechaEspecifica,
  verificarConexion,
  calcularRangoDia,
  parsearPeso,
  LOCALES_MAP,
};
