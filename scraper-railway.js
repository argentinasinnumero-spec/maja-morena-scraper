'use strict';

/**
 * Entry point para Railway.
 * Corre el scraper diario completo y sale.
 * Railway lo ejecuta via cron schedule.
 */

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

const { descargarFechaEspecifica } = require('./tools/nucleoConector');
const db = admin.firestore();

function fechaIsoDeHoy() {
  // Hora Argentina (UTC-3)
  const ahora = new Date();
  ahora.setHours(ahora.getHours() - 3);
  return ahora.toISOString().split('T')[0];
}

function diasEntre(desdeIso, hastaIso) {
  const dias = [];
  const d = new Date(desdeIso);
  const hasta = new Date(hastaIso);
  d.setDate(d.getDate() + 1);
  while (d <= hasta) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

(async () => {
  console.log('[Railway Scraper] Iniciando —', new Date().toISOString());

  const hoy = fechaIsoDeHoy();
  console.log(`[Railway Scraper] Fecha Argentina: ${hoy}`);

  // Buscar último día guardado
  const snap = await db.collection('resumen_diario')
    .orderBy('fecha', 'desc')
    .limit(1)
    .get();

  if (snap.empty) {
    console.log('[Railway Scraper] Sin datos previos, descargando hoy...');
    await descargarFechaEspecifica(hoy);
    console.log('[Railway Scraper] Listo.');
    process.exit(0);
  }

  const ultimoDia = snap.docs[0].data().fecha || snap.docs[0].id;
  console.log(`[Railway Scraper] Último día: ${ultimoDia} | Hoy: ${hoy}`);

  if (ultimoDia >= hoy) {
    console.log('[Railway Scraper] Ya está al día.');
    process.exit(0);
  }

  const faltantes = diasEntre(ultimoDia, hoy);
  console.log(`[Railway Scraper] Días a descargar: ${faltantes.join(', ')}`);

  for (const fecha of faltantes) {
    console.log(`\n[Railway Scraper] Descargando ${fecha}...`);
    try {
      const datos = await descargarFechaEspecifica(fecha);
      console.log(`  ✓ ${datos.locales_exitosos} locales | $${datos.venta_real?.toLocaleString('es-AR')}`);
    } catch (e) {
      console.error(`  ✗ Error en ${fecha}: ${e.message}`);
    }
  }

  console.log('\n[Railway Scraper] Completado.');
  process.exit(0);
})().catch(e => {
  console.error('[Railway Scraper] Error fatal:', e.message);
  process.exit(1);
});
