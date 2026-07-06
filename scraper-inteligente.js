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

const { descargarFechaEspecifica, ejecutarDescargaDiaria } = require('./tools/nucleoConector');
const { subirArchivosDelDia } = require('./tools/subirAEstadisticas');
const db = admin.firestore();

function fechaIsoDeHoy() {
  return new Date().toISOString().split('T')[0];
}

function diasEntre(desdeIso, hastaIso) {
  const dias = [];
  const d = new Date(desdeIso);
  const hasta = new Date(hastaIso);
  d.setDate(d.getDate() + 1); // empezar desde el día siguiente al último bajado
  while (d <= hasta) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

(async () => {
  console.log('[Scraper Inteligente] Iniciando...');

  // 1. Buscar el último día guardado en resumen_diario
  const snap = await db.collection('resumen_diario')
    .orderBy('fecha', 'desc')
    .limit(1)
    .get();

  const ayer = fechaIsoDeHoy();

  if (snap.empty) {
    console.log('[Scraper Inteligente] Sin datos previos, descargando...');
    const datos = await ejecutarDescargaDiaria();
    await subirArchivosDelDia(datos.fecha_iso).catch(() => {});
    console.log(`[Scraper Inteligente] Listo. $${datos.venta_real?.toLocaleString('es-AR')}`);
    process.exit(0);
  }

  const ultimoDia = snap.docs[0].data().fecha || snap.docs[0].id;
  console.log(`[Scraper Inteligente] Último día guardado: ${ultimoDia} | Ayer: ${ayer}`);

  if (ultimoDia >= ayer) {
    console.log('[Scraper Inteligente] Ya está al día, nada que recuperar.');
    process.exit(0);
  }

  // 2. Calcular días faltantes
  const diasFaltantes = diasEntre(ultimoDia, ayer);
  console.log(`[Scraper Inteligente] Días faltantes: ${diasFaltantes.length} → ${diasFaltantes.join(', ')}`);

  // 3. Descargar cada día faltante
  for (const fecha of diasFaltantes) {
    console.log(`\n[Scraper Inteligente] Descargando ${fecha}...`);
    try {
      const datos = await descargarFechaEspecifica(fecha);
      console.log(`  ✓ ${datos.locales_exitosos} locales | $${datos.venta_real?.toLocaleString('es-AR')}`);
      await subirArchivosDelDia(fecha).catch(() => {});
    } catch (e) {
      console.error(`  ✗ Error en ${fecha}: ${e.message}`);
    }
  }

  console.log('\n[Scraper Inteligente] Listo. Todos los días recuperados.');
  process.exit(0);
})().catch(e => {
  console.error('[Scraper Inteligente] Error fatal:', e.message);
  process.exit(1);
});
