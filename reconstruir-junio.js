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

const { descargarFechaEspecifica } = require('./tools/nucleoConector');
const db = admin.firestore();

const diasJunio = [];
for (let d = 1; d <= 25; d++) {
  diasJunio.push(`2026-06-${String(d).padStart(2,'0')}`);
}

(async () => {
  // 1. Scrapear TODOS los días del 1 al 25 (sobreescribe lo que había)
  console.log('=== SCRAPING COMPLETO 1-25 JUNIO ===\n');
  for (const fecha of diasJunio) {
    console.log(`\n[${fecha}] Descargando...`);
    try {
      const r = await descargarFechaEspecifica(fecha);
      console.log(`  ✓ ${r.locales_exitosos} locales OK | ${r.locales_con_error} errores | $${r.venta_real?.toLocaleString('es-AR')}`);
    } catch(e) {
      console.log(`  ✗ ERROR: ${e.message}`);
    }
  }

  // 2. Leer todos los resumen_diario del 1 al 26 y reconstruir acumulado
  console.log('\n\n=== RECONSTRUYENDO resumen_mensual/2026-06 ===');
  const snap = await db.collection('resumen_diario')
    .where('fecha', '>=', '2026-06-01')
    .where('fecha', '<=', '2026-06-30')
    .get();

  console.log(`Días disponibles: ${snap.size}`);

  const locales = {};
  const diasIncluidos = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    diasIncluidos.push(doc.id);
    for (const r of (d.ranking_locales || [])) {
      const lid = r.local_id;
      if (!locales[lid]) {
        locales[lid] = {
          nombre: r.nombre, tipo: r.tipo,
          venta_real: 0, efectivo: 0, credito: 0,
          debito: 0, mercado_pago: 0, vales: 0, operaciones: 0,
        };
      }
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

  await db.collection('resumen_mensual').doc('2026-06').set({
    mes: '2026-06',
    locales,
    dias_incluidos: diasIncluidos.sort(),
    ultima_actualizacion: new Date(),
    venta_real_total,
  });

  console.log(`\n✅ resumen_mensual/2026-06 reconstruido:`);
  console.log(`   Días: ${diasIncluidos.length} | Total mes: $${venta_real_total.toLocaleString('es-AR')}`);
  console.log('\nDetalle por local:');
  Object.entries(locales)
    .sort((a,b) => b[1].venta_real - a[1].venta_real)
    .forEach(([, l]) => console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')}`));

  console.log('\n✅ Listo.');
  process.exit(0);
})().catch(e => {
  console.error('Error fatal:', e.message);
  process.exit(1);
});
