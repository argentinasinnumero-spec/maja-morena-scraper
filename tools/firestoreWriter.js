'use strict';
const { getDb } = require('./firestoreReader');
const config    = require('../config');

function ts() {
  return new Date();
}

async function saveOportunidad(data, cicloId) {
  const db  = getDb();
  const doc = {
    tipo:              data.tipo || 'general',
    agente_origen:     data.agente_origen || 'sistema',
    prioridad:         data.prioridad || 5,
    estado:            'pendiente',
    local:             data.local || '',
    localId:           data.localId || '',
    titulo:            data.titulo || '',
    descripcion:       data.descripcion || '',
    accion:            data.accion || '',
    impacto_estimado:  data.impacto_estimado || '',
    revenue_potencial: data.revenue_potencial || 0,
    datos_soporte:     data.datos_soporte || {},
    created_at:        ts(),
    ciclo_id:          cicloId || '',
  };
  const ref = await db.collection(config.colecciones.oportunidades).add(doc);
  return ref.id;
}

async function saveAlerta(data, cicloId) {
  const db  = getDb();
  const doc = {
    nivel:           data.nivel || 'media',
    tipo:            data.tipo  || 'general',
    local:           data.local || '',
    titulo:          data.titulo || '',
    descripcion:     data.descripcion || '',
    datos:           data.datos || {},
    accion_sugerida: data.accion_sugerida || '',
    estado:          'nueva',
    created_at:      ts(),
    ciclo_id:        cicloId || '',
  };
  const ref = await db.collection(config.colecciones.alertas).add(doc);
  return ref.id;
}

async function saveCampaña(data, cicloId) {
  const db  = getDb();
  const doc = {
    nombre:           data.nombre || '',
    tipo:             data.tipo   || 'general',
    agente_creador:   data.agente_creador || 'sistema',
    estado:           'propuesta',
    descripcion:      data.descripcion || '',
    oferta:           data.oferta || {},
    segmento:         data.segmento || '',
    mensaje_whatsapp: data.mensaje_whatsapp || '',
    duracion_dias:    data.duracion_dias || 7,
    revenue_esperado: data.revenue_esperado || 0,
    metricas: {
      enviados:     0,
      conversiones: 0,
      revenue_real: 0,
    },
    created_at: ts(),
    ciclo_id:   cicloId || '',
  };
  const ref = await db.collection(config.colecciones.campañas).add(doc);
  return ref.id;
}

async function saveCiclo(cicloId, data) {
  const db = getDb();
  await db.collection(config.colecciones.ciclos).doc(cicloId).set(data);
}

async function updateEstadoAgente(estado) {
  const db = getDb();
  await db.collection(config.colecciones.estado).doc('actual').set(
    { ...estado, updated_at: ts() },
    { merge: true }
  );
}

async function saveAgenteMemoria(agenteId, data) {
  const db = getDb();
  await db.collection(config.colecciones.memoria).doc(agenteId).set(
    { ...data, updated_at: ts() },
    { merge: true }
  );
}

async function markTriggerDone(triggerId) {
  const db = getDb();
  await db.collection(config.colecciones.triggers).doc(triggerId).update({
    estado:    'procesado',
    processed: ts(),
  });
}

async function limpiarAlertas(diasAntiguedad = 30) {
  const db     = getDb();
  const cutoff = new Date(Date.now() - diasAntiguedad * 24 * 60 * 60 * 1000);
  const snap   = await db
    .collection(config.colecciones.alertas)
    .where('estado', '==', 'resuelta')
    .where('created_at', '<', cutoff)
    .get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  if (!snap.empty) await batch.commit();
}

module.exports = {
  saveOportunidad,
  saveAlerta,
  saveCampaña,
  saveCiclo,
  updateEstadoAgente,
  saveAgenteMemoria,
  markTriggerDone,
  limpiarAlertas,
};
