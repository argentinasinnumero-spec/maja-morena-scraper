'use strict';

const path = require('path');
const fs   = require('fs');

const DESCARGAS_DIR = path.join(__dirname, '..', 'descargas_nucleo');
const esperar = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Se loguea al sistema de estadísticas y sube todos los Excel
 * del día comercial indicado usando el Importador POS.
 *
 * @param {string} fechaIso - "2026-06-15" (fecha del archivo en el nombre)
 */
async function subirArchivosDelDia(fechaIso) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch { throw new Error('Puppeteer no disponible'); }

  const url      = process.env.ESTADISTICAS_URL    || 'https://estadisticas-81fc4.web.app';
  const email    = process.env.ESTADISTICAS_EMAIL;
  const password = process.env.ESTADISTICAS_PASSWORD;

  if (!email || !password) throw new Error('Faltan ESTADISTICAS_EMAIL / ESTADISTICAS_PASSWORD en .env');

  // Buscar todos los xlsx del día (nombre contiene la fecha_iso o la fecha descargada)
  const todosLosArchivos = fs.readdirSync(DESCARGAS_DIR)
    .filter(f => f.endsWith('.xlsx') || f.endsWith('.xls'))
    .map(f => path.join(DESCARGAS_DIR, f));

  // Los archivos de Núcleo IT se llaman "Historial de pedidos DD_M_YYYY HH_MM_SS.xlsx"
  // donde DD_M_YYYY es la fecha en que se descargaron (= día siguiente al día comercial)
  // Ej: día comercial 2026-06-15 → descargado el 16/6/2026 → "16_6_2026"
  // Archivos descargados el día siguiente al día comercial (scraper corre de mañana)
  // día comercial 2026-06-22 → descargado el 23/6 → patrón "23_6_2026"
  // Pero si se corre el mismo día comercial (backfill manual) → patrón "22_6_2026"
  const [anio, mes, dia] = fechaIso.split('-').map(Number);
  const descarga1 = new Date(anio, mes - 1, dia + 1); // día siguiente (scraper automático)
  const descarga0 = new Date(anio, mes - 1, dia);     // mismo día (backfill manual)
  const patron1 = `${descarga1.getDate()}_${descarga1.getMonth() + 1}_${descarga1.getFullYear()}`;
  const patron0 = `${descarga0.getDate()}_${descarga0.getMonth() + 1}_${descarga0.getFullYear()}`;

  const archivosDelDia = todosLosArchivos.filter(ruta => {
    const nombre = path.basename(ruta);
    return nombre.includes(patron1) || nombre.includes(patron0) || nombre.includes(fechaIso);
  });

  if (!archivosDelDia.length) {
    console.warn(`[Estadísticas] No hay archivos para ${fechaIso} en ${DESCARGAS_DIR}`);
    return { exito: false, error: 'Sin archivos para subir', archivos: 0 };
  }

  console.log(`[Estadísticas] Subiendo ${archivosDelDia.length} archivos del día ${fechaIso}...`);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 900 });

    // 1. Ir al login
    console.log('[Estadísticas] Navegando al login...');
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await esperar(2000);

    // 2. Completar email y contraseña
    await page.waitForSelector('input[type="email"], input[type="text"]', { timeout: 10000 });
    const emailInput = await page.$('input[type="email"]') || await page.$('input[type="text"]');
    await emailInput.click({ clickCount: 3 });
    await emailInput.type(email);

    await page.waitForSelector('input[type="password"]', { timeout: 5000 });
    const passInput = await page.$('input[type="password"]');
    await passInput.click({ clickCount: 3 });
    await passInput.type(password);

    // 3. Submit login
    await page.keyboard.press('Enter');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await esperar(3000);
    console.log('[Estadísticas] Login OK');

    // Helper: buscar botón por texto
    const findBtn = async (textos) => {
      const btns = await page.$$('button, a');
      for (const btn of btns) {
        const txt = await btn.evaluate(el => el.textContent || '');
        if (textos.some(t => txt.includes(t))) return btn;
      }
      return null;
    };

    // 4. Ir a Administración
    const adminBtn = await findBtn(['Administración']);
    if (adminBtn) { await adminBtn.click(); await esperar(1500); }

    // 5. Ir a Importar POS
    const posBtn = await findBtn(['Importar POS']);
    if (posBtn) { await posBtn.click(); await esperar(1500); }
    console.log('[Estadísticas] En panel Importar POS');

    // 6. Subir todos los archivos juntos al input file
    const fileInput = await page.$('input[type="file"]');
    if (!fileInput) throw new Error('No se encontró el input de archivos en la página');

    await fileInput.uploadFile(...archivosDelDia);
    console.log(`[Estadísticas] ${archivosDelDia.length} archivos cargados en el input`);
    await esperar(5000); // esperar que el sistema procese y muestre preview

    // 7. Esperar a que aparezca el botón "Guardar" y clickearlo
    const guardarBtn = await findBtn(['Guardar', 'guardar', 'Importar', 'Confirmar']);
    if (!guardarBtn) throw new Error('No apareció el botón de guardar/confirmar');

    await guardarBtn.click();
    console.log('[Estadísticas] Guardando...');
    await esperar(8000); // esperar que Firestore procese el batch

    // 8. Verificar mensaje de éxito
    const bodyText = await page.evaluate(() => document.body.innerText);
    const exito = bodyText.includes('Guardados') || bodyText.includes('guardado') || bodyText.includes('✅');
    console.log(`[Estadísticas] Resultado: ${exito ? '✅ OK' : '⚠️ Sin confirmación visible'}`);

    await browser.close();
    return { exito: true, archivos: archivosDelDia.length };

  } catch (e) {
    await browser.close();
    console.error('[Estadísticas] Error:', e.message);
    return { exito: false, error: e.message, archivos: archivosDelDia.length };
  }
}

module.exports = { subirArchivosDelDia };

// Permite correr directamente: node subirAEstadisticas.js [fechaIso]
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
  const fecha = process.argv[2] || new Date(Date.now() - 86400000).toISOString().split('T')[0];
  console.log(`[Estadísticas] Corriendo para fecha: ${fecha}`);
  subirArchivosDelDia(fecha).then(r => {
    console.log('Resultado final:', JSON.stringify(r));
    process.exit(r.exito ? 0 : 1);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
