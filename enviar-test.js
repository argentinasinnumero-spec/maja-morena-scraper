'use strict';
// Envío de prueba — solo a un destinatario, fechas específicas
require('dotenv').config();
const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert({
    projectId:   process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey:  process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  })});
}
const db = admin.firestore();

// Sobreescribir destinatario para el test
process.env.MAIL_DESTINO = process.argv[2] || 'gonzalofsegura@gmail.com';
const { enviarReporte } = require('./mailer');

const fechas = process.argv.slice(3).length ? process.argv.slice(3) : ['2026-09-01','2026-09-02','2026-09-03','2026-09-04'];

(async () => {
  for (const fecha of fechas) {
    console.log(`\nEnviando reporte ${fecha} → ${process.env.MAIL_DESTINO}`);
    const [snapD, snapM] = await Promise.all([
      db.collection('resumen_diario').doc(fecha).get(),
      db.collection('resumen_mensual').doc(fecha.slice(0,7)).get(),
    ]);
    if (!snapD.exists) { console.warn(`  Sin doc para ${fecha}`); continue; }
    await enviarReporte(snapD.data(), snapM.exists ? snapM.data() : null);
  }
  process.exit(0);
})().catch(e => { console.error(e.message); process.exit(1); });
