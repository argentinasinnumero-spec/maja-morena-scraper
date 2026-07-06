'use strict';

require('dotenv').config();

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

const { ejecutarDescargaDiaria } = require('./tools/nucleoConector');
const { subirArchivosDelDia }    = require('./tools/subirAEstadisticas');

(async () => {
  console.log('[Scraper Diario] Iniciando...');

  // 1. Descargar ventas de todos los locales
  const datos = await ejecutarDescargaDiaria();
  console.log(`[Scraper Diario] Scraping OK: ${datos.locales_exitosos} locales | $${datos.venta_real?.toLocaleString('es-AR')}`);

  // 2. Subir los Excel al sistema de estadísticas
  const fechaComercial = datos.fecha_iso; // "2026-06-16"
  const resultado = await subirArchivosDelDia(fechaComercial);
  if (resultado.exito) {
    console.log(`[Scraper Diario] ${resultado.archivos} archivos subidos a estadísticas OK`);
  } else {
    console.warn(`[Scraper Diario] Error subiendo a estadísticas: ${resultado.error}`);
  }

  console.log('[Scraper Diario] Listo.');
  process.exit(0);
})().catch(e => {
  console.error('[Scraper Diario] Error fatal:', e.message);
  process.exit(1);
});
