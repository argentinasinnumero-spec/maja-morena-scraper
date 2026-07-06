'use strict';
require('dotenv').config();
const admin = require('firebase-admin');
const config = require('../config');

let _db = null;

function getDb() {
  if (_db) return _db;
  if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId:   process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey:  (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n'),
      }),
    });
  }
  _db = admin.firestore();
  return _db;
}

function normalizarMes(mes) {
  if (mes === null || mes === undefined) return null;
  if (typeof mes === 'object' && typeof mes.toDate === 'function') {
    return mes.toDate().getMonth() + 1;
  }
  const n = Number(mes);
  return Number.isFinite(n) && n >= 1 && n <= 12 ? n : null;
}

function normalizarAno(ano) {
  const v = ano?.ano ?? ano;
  if (typeof v === 'object' && typeof v.toDate === 'function') {
    return v.toDate().getFullYear();
  }
  const n = Number(v);
  return Number.isFinite(n) && n >= 2000 && n <= 2100 ? n : null;
}

function normalizarId(str) {
  if (!str) return '';
  return String(str)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_]/g, '');
}

async function getUltimosNMeses(n = 6) {
  const db  = getDb();
  const hoy = new Date();
  const periodos = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(hoy.getFullYear(), hoy.getMonth() - i, 1);
    periodos.push({ mes: d.getMonth() + 1, ano: d.getFullYear() });
  }

  const snap  = await db.collection(config.colecciones.ventas).get();
  const todos = snap.docs.map(doc => {
    const d   = doc.data();
    const mes = normalizarMes(d.mes);
    const ano = normalizarAno(d.ano ?? d.año);
    return {
      ...d,
      id:            doc.id,
      mes,
      ano,
      ventas_pesos:  Number(d.ventas_pesos ?? d.ventas ?? 0) || 0,
      dependenciaId: normalizarId(d.dependenciaId || d.dependencia),
    };
  });

  return todos.filter(v =>
    periodos.some(p => p.mes === v.mes && p.ano === v.ano)
  );
}

async function getDependencias() {
  const db   = getDb();
  const snap = await db.collection(config.colecciones.dependencias).get();
  return snap.docs
    .map(doc => ({ id: doc.id, ...doc.data() }))
    .filter(d => d.activo !== false);
}

async function getPrecios() {
  const db   = getDb();
  const snap = await db.collection(config.colecciones.precios).get();
  return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

async function getParametrosUltimos() {
  const db   = getDb();
  const snap = await db
    .collection(config.colecciones.parametros)
    .orderBy('fecha', 'desc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

async function getAgenteMemoria(agenteId) {
  const db  = getDb();
  const doc = await db.collection(config.colecciones.memoria).doc(agenteId).get();
  return doc.exists ? doc.data() : {};
}

async function getPendingTrigger() {
  const db   = getDb();
  const snap = await db
    .collection(config.colecciones.triggers)
    .where('estado', '==', 'pendiente')
    .orderBy('created_at', 'asc')
    .limit(1)
    .get();
  if (snap.empty) return null;
  return { id: snap.docs[0].id, ...snap.docs[0].data() };
}

module.exports = {
  getDb,
  getUltimosNMeses,
  getDependencias,
  getPrecios,
  getParametrosUltimos,
  getAgenteMemoria,
  getPendingTrigger,
  normalizarId,
};
