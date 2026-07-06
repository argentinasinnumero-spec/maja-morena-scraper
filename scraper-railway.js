'use strict';

/**
 * Entry point para Railway.
 * Corre todos los días a las 10am Argentina (13:00 UTC).
 * Descarga el día comercial de ayer y recupera días perdidos.
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

const { ejecutarDescargaDiaria, descargarFechaEspecifica } = require('./tools/nucleoConector');
const db = admin.firestore();

// Fecha de hoy en Argentina (UTC-3)
function fechaArgentina() {
  const now = new Date();
  now.setHours(now.getUTCHours() - 3);
  return now.toISOString().split('T')[0];
}

// El doc resumen_diario/FECHA contiene el día comercial de FECHA-1.
// Para obtener el doc /TARGET hay que llamar descargarFechaEspecifica(TARGET - 1 día).
function restarUnDia(fechaIso) {
  const d = new Date(fechaIso + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  return d.toISOString().split('T')[0];
}

function diasEntre(desdeIso, hastaIso) {
  const dias = [];
  const d = new Date(desdeIso + 'T12:00:00Z');
  const hasta = new Date(hastaIso + 'T12:00:00Z');
  d.setDate(d.getDate() + 1);
  while (d <= hasta) {
    dias.push(d.toISOString().split('T')[0]);
    d.setDate(d.getDate() + 1);
  }
  return dias;
}

(async () => {
  console.log('[Railway] Iniciando —', new Date().toISOString());

  const hoyArg = fechaArgentina();
  console.log(`[Railway] Fecha Argentina: ${hoyArg}`);

  // El doc de hoy = resumen_diario/{hoyArg} = día comercial de ayer
  // Buscar último doc guardado
  const snap = await db.collection('resumen_diario')
    .orderBy('fecha', 'desc')
    .limit(1)
    .get();

  if (snap.empty) {
    console.log('[Railway] Sin datos previos, descargando...');
    await ejecutarDescargaDiaria();
    console.log('[Railway] Listo.');
    process.exit(0);
  }

  const ultimoDoc = snap.docs[0].id; // fecha_iso del último doc
  console.log(`[Railway] Último doc: ${ultimoDoc} | Doc esperado hoy: ${hoyArg}`);

  if (ultimoDoc >= hoyArg) {
    console.log('[Railway] Ya está al día.');
    process.exit(0);
  }

  // Docs faltantes entre ultimoDoc y hoyArg (inclusive)
  const docsFaltantes = diasEntre(ultimoDoc, hoyArg);
  console.log(`[Railway] Docs a crear: ${docsFaltantes.join(', ')}`);

  for (const docFecha of docsFaltantes) {
    // Para crear resumen_diario/docFecha, descargar el día comercial de docFecha-1
    const fechaComercial = restarUnDia(docFecha);
    console.log(`\n[Railway] Descargando día comercial ${fechaComercial} → doc ${docFecha}...`);
    try {
      const datos = await descargarFechaEspecifica(fechaComercial);
      console.log(`  ✓ ${datos.locales_exitosos} locales | $${datos.venta_real?.toLocaleString('es-AR')}`);
    } catch (e) {
      console.error(`  ✗ Error: ${e.message}`);
    }
  }

  console.log('\n[Railway] Completado.');
  process.exit(0);
})().catch(e => {
  console.error('[Railway] Error fatal:', e.message);
  process.exit(1);
});
