'use strict';

/**
 * Sincroniza resumen_diario del agente → ventas_diarias del sistema de estadísticas.
 * Lee los datos de Firestore del agente y escribe directo en Firestore de estadísticas.
 * No depende de que Núcleo IT tenga el export funcionando.
 */

const { initializeApp, getApps } = require('firebase/app');
const { getAuth, signInWithEmailAndPassword } = require('firebase/auth');
const { getFirestore, doc, setDoc } = require('firebase/firestore');

const STATS_CONFIG = {
  apiKey:      'AIzaSyBGSA-zxnJWEVuzCgyiUvaKhRBjCL1hORs',
  authDomain:  'estadisticas-81fc4.firebaseapp.com',
  projectId:   'estadisticas-81fc4',
};

// Mapeo local_id del agente → dependenciaId del sistema de estadísticas
const LOCAL_ID_MAP = {
  majamorena:      'libertad',
  majasanmartin:   'san_martin',
  majasanmartin58: 'express',
  majasarmiento:   'sarmiento',
  majamorenawo:    'wo',
  majacosquin:     'cosquin',
  mmmorteros:      'morteros',
  majariocuarto:   'rio_cuarto',
  majacarcano:     'carcano',
  majaaltagracia:  'alta_gracia',
  majalossauces:   'sol_y_rio',
  majamorenatanti: 'tanti',
  majasantacruz:   'santa_cruz',
};

async function sincronizarDia(resumenDiario) {
  const fecha = resumenDiario.fecha_iso || resumenDiario.fecha;
  if (!fecha) throw new Error('resumenDiario sin fecha_iso');

  const ranking = resumenDiario.ranking_locales || [];
  if (!ranking.length) {
    console.warn(`[Estadísticas] Sin ranking_locales para ${fecha}`);
    return { escritos: 0 };
  }

  // Inicializar Firebase cliente (estadísticas) — evitar doble init
  const appName = 'estadisticas-client';
  const appExistente = getApps().find(a => a.name === appName);
  const app   = appExistente || initializeApp(STATS_CONFIG, appName);
  const auth  = getAuth(app);
  const dbEst = getFirestore(app);

  // Login
  const email    = process.env.ESTADISTICAS_EMAIL;
  const password = process.env.ESTADISTICAS_PASSWORD;
  if (!email || !password) throw new Error('Faltan ESTADISTICAS_EMAIL / ESTADISTICAS_PASSWORD');
  await signInWithEmailAndPassword(auth, email, password);

  const [yyyy, mm] = fecha.split('-').map(Number);
  let escritos = 0;

  for (const local of ranking) {
    const depId = LOCAL_ID_MAP[local.local_id];
    if (!depId) {
      console.warn(`  [Estadísticas] local_id desconocido: ${local.local_id}`);
      continue;
    }

    const docId   = `${depId}_${fecha}`;
    const docData = {
      dependenciaId: depId,
      fecha,
      mes:          mm,
      ano:          yyyy,
      total:        local.venta_real || 0,
      saldo:        local.saldo_cc   || 0,
      efectivo:     local.efectivo   || 0,
      credito:      local.credito    || 0,
      debito:       local.debito     || 0,
      mercadopago:  local.mercado_pago || 0,
      vales:        local.vales      || 0,
      pedidos:      local.operaciones || 0,
      // porHora no disponible desde DOM fallback — se omite
    };

    await setDoc(doc(dbEst, 'ventas_diarias', docId), docData, { merge: true });
    console.log(`  [Estadísticas] ✓ ${depId} ${fecha}: $${local.venta_real?.toLocaleString('es-AR')} (${local.operaciones} pedidos)`);
    escritos++;
  }

  return { escritos };
}

module.exports = { sincronizarDia };

// Permite correr directamente: node sincronizarEstadisticas.js [fecha]
if (require.main === module) {
  require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
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
  const fecha = process.argv[2] || new Date().toISOString().split('T')[0];
  console.log(`[Estadísticas] Sincronizando ${fecha}...`);
  db.collection('resumen_diario').doc(fecha).get().then(async snap => {
    if (!snap.exists) { console.error('Doc no existe:', fecha); process.exit(1); }
    const res = await sincronizarDia(snap.data());
    console.log(`[Estadísticas] Listo — ${res.escritos} locales escritos.`);
    process.exit(0);
  }).catch(e => { console.error(e.message); process.exit(1); });
}
