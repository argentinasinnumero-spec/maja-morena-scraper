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

const db = admin.firestore();

(async () => {
  console.log('=== RECONSTRUYENDO resumen_mensual/2026-06 ===\n');

  const snap = await db.collection('resumen_diario')
    .where('fecha', '>=', '2026-06-01')
    .where('fecha', '<=', '2026-06-30')
    .get();

  console.log(`Días encontrados en Firestore: ${snap.size}`);
  snap.docs.forEach(d => console.log(`  ${d.id} → fecha: ${d.data().fecha}`));

  const locales = {};
  const diasIncluidos = [];

  for (const doc of snap.docs) {
    const d = doc.data();
    diasIncluidos.push(doc.id);
    for (const r of (d.ranking_locales || [])) {
      const lid = r.local_id;
      if (!lid) continue;
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
    .sort((a, b) => b[1].venta_real - a[1].venta_real)
    .forEach(([, l]) => console.log(`  ${l.tipo.padEnd(12)} ${l.nombre.padEnd(15)} $${l.venta_real.toLocaleString('es-AR')}`));

  process.exit(0);
})().catch(e => {
  console.error('Error:', e.message);
  process.exit(1);
});
