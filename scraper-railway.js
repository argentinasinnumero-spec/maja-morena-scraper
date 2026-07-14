'use strict';

/**
 * Entry point para Railway.
 * Corre todos los días a las 10am Argentina (13:00 UTC).
 * Descarga el día comercial de ayer y recupera días perdidos.
 * Si el día anterior tuvo locales con error, lo re-intenta automáticamente.
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

function fechaArgentina() {
  const now = new Date();
  now.setHours(now.getUTCHours() - 3);
  return now.toISOString().split('T')[0];
}

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

async function descargarDoc(docFecha) {
  const fechaComercial = restarUnDia(docFecha);
  console.log(`\n[Railway] Descargando día comercial ${fechaComercial} → doc ${docFecha}...`);
  const datos = await descargarFechaEspecifica(fechaComercial);
  const errores = datos.locales_con_error || 0;
  console.log(`  ✓ ${datos.locales_exitosos} locales OK${errores > 0 ? ` | ⚠️ ${errores} con error` : ''} | $${datos.venta_real?.toLocaleString('es-AR')}`);
  return datos;
}

(async () => {
  console.log('[Railway] Iniciando —', new Date().toISOString());

  const hoyArg = fechaArgentina();
  console.log(`[Railway] Fecha Argentina: ${hoyArg}`);

  const snap = await db.collection('resumen_diario')
    .orderBy('fecha', 'desc')
    .limit(1)
    .get();

  if (snap.empty) {
    console.log('[Railway] Sin datos previos, descargando hoy...');
    await descargarDoc(hoyArg);
    console.log('[Railway] Listo.');
    process.exit(0);
  }

  const ultimoDoc = snap.docs[0].id;
  console.log(`[Railway] Último doc: ${ultimoDoc} | Doc esperado hoy: ${hoyArg}`);

  // Re-intentar días incompletos de los últimos 3 días
  const ultimosTresDias = diasEntre(restarUnDia(restarUnDia(hoyArg)), hoyArg);
  for (const fecha of ultimosTresDias) {
    const docRef = await db.collection('resumen_diario').doc(fecha).get();
    if (!docRef.exists) continue;
    const data = docRef.data();
    const errores = data.locales_con_error || 0;
    if (errores > 0) {
      const localesConError = (data.errores || []).map(e => e.usuario).join(', ') || `${errores} locales`;
      console.log(`[Railway] ⚠️  Doc ${fecha} tiene ${errores} locales con error (${localesConError}) — re-intentando...`);
      try {
        await descargarDoc(fecha);
      } catch (e) {
        console.error(`  ✗ Re-intento fallido: ${e.message}`);
      }
    }
  }

  // Descargar días faltantes hasta hoy
  if (ultimoDoc < hoyArg) {
    const docsFaltantes = diasEntre(ultimoDoc, hoyArg);
    console.log(`[Railway] Docs nuevos a crear: ${docsFaltantes.join(', ')}`);
    for (const docFecha of docsFaltantes) {
      try {
        await descargarDoc(docFecha);
      } catch (e) {
        console.error(`  ✗ Error: ${e.message}`);
      }
    }
  } else {
    console.log('[Railway] Ya está al día.');
  }

  console.log('\n[Railway] Completado.');
  process.exit(0);
})().catch(e => {
  console.error('[Railway] Error fatal:', e.message);
  process.exit(1);
});
