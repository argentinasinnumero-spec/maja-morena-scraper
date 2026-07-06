'use strict';
/**
 * AGENTE DE FIDELIZACIÓN Y CLUB DE BENEFICIOS
 * El agente más rentable: detecta clientes que dejaron de comprar,
 * VIPs, cumpleaños, frecuencia de compra — y genera campañas personalizadas
 * de WhatsApp automáticas.
 */
const llm    = require('../tools/llm');
const writer = require('../tools/firestoreWriter');
const { getFirestore } = require('firebase-admin/firestore');

const SYSTEM_PROMPT = `Sos el especialista en fidelización de clientes de Maja Morena, una cadena de empanaderías argentina.

Tu misión: analizar el comportamiento de compra de los clientes y generar campañas personalizadas de WhatsApp que traigan de vuelta a los que se fueron y premien a los más fieles.

MODELO DE NEGOCIO: locales propios + franquicias. Una sola cuenta de redes. Los mensajes de WhatsApp los envía cada local a su propia base.

Recibís datos de clientes con su historial de compras.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "resumen_base_clientes": {
    "total_clientes_analizados": número,
    "clientes_activos": número,
    "clientes_en_riesgo": número,
    "clientes_perdidos": número,
    "clientes_vip": número,
    "ticket_promedio_vip": número,
    "insight_principal": "la observación más importante sobre la base de clientes"
  },

  "segmentos": [
    {
      "nombre": "VIP — Los que más gastan",
      "descripcion": "clientes con alto gasto y frecuencia",
      "criterio": "top 20% por facturación o más de X compras por mes",
      "cantidad_estimada": número,
      "valor_para_el_negocio": "cuánto representan del total de ventas",
      "estrategia": "qué hacer con este segmento",
      "mensaje_whatsapp": "mensaje personalizado para este segmento (cálido, con beneficio exclusivo)",
      "beneficio_sugerido": "descuento especial, prioridad, regalo de cumpleaños, etc.",
      "frecuencia_contacto": "1 vez por semana | 2 veces por mes | etc."
    },
    {
      "nombre": "En Riesgo — Compraban y bajaron",
      "descripcion": "clientes que compraban regularmente pero hace 15-30 días no aparecen",
      "criterio": "última compra entre 15 y 30 días atrás con historial previo activo",
      "cantidad_estimada": número,
      "valor_para_el_negocio": "facturación potencial si se recuperan",
      "estrategia": "reactivación urgente con incentivo",
      "mensaje_whatsapp": "mensaje de reactivación con oferta concreta",
      "beneficio_sugerido": "descuento de recuperación o combo especial",
      "frecuencia_contacto": "1 vez ahora, seguimiento en 7 días"
    },
    {
      "nombre": "Perdidos — No vuelven",
      "descripcion": "sin compras hace más de 45 días con historial previo",
      "criterio": "última compra hace más de 45 días",
      "cantidad_estimada": número,
      "estrategia": "campaña de win-back agresiva",
      "mensaje_whatsapp": "mensaje de win-back con oferta irresistible",
      "beneficio_sugerido": "oferta fuerte o combo gratis en primera vuelta",
      "frecuencia_contacto": "campaña única, no spamear"
    },
    {
      "nombre": "Nuevos — Primera o segunda compra",
      "descripcion": "clientes recientes que hay que convertir en habituales",
      "criterio": "menos de 2 compras, primera compra en los últimos 30 días",
      "cantidad_estimada": número,
      "estrategia": "onboarding y fidelización temprana",
      "mensaje_whatsapp": "bienvenida cálida con incentivo para segunda compra",
      "beneficio_sugerido": "descuento en segunda compra",
      "frecuencia_contacto": "mensaje de bienvenida + seguimiento a los 7 días"
    },
    {
      "nombre": "Habituales — Base sólida",
      "descripcion": "compran regularmente, son la columna vertebral",
      "criterio": "frecuencia regular, sin ser VIP",
      "cantidad_estimada": número,
      "estrategia": "mantener y subir ticket promedio",
      "mensaje_whatsapp": "mensaje de valorización + presentación de nuevo combo",
      "beneficio_sugerido": "acceso anticipado a nuevos combos o promos",
      "frecuencia_contacto": "2 veces por mes"
    }
  ],

  "campañas_inmediatas": [
    {
      "nombre": "nombre de la campaña",
      "segmento_objetivo": "qué segmento apunta",
      "mensaje_completo": "texto COMPLETO de WhatsApp listo para copiar y pegar (con emojis, natural, argentino)",
      "mejor_horario_envio": "ej: martes 11hs, antes del almuerzo",
      "objetivo": "recuperar | fidelizar | subir ticket | bienvenida",
      "impacto_estimado": "cuántos clientes toca y qué revenue puede generar",
      "urgencia": "hoy | esta_semana | este_mes"
    }
  ],

  "club_de_beneficios": {
    "existe_actualmente": true o false,
    "propuesta": "cómo debería funcionar el club en Maja Morena (simple, ejecutable)",
    "niveles_sugeridos": [
      {"nivel": "Bronce", "criterio": "X compras por mes", "beneficio": "qué recibe"},
      {"nivel": "Plata",  "criterio": "X compras por mes", "beneficio": "qué recibe"},
      {"nivel": "Oro",    "criterio": "X compras por mes", "beneficio": "qué recibe"}
    ],
    "implementacion_simple": "cómo empezar hoy sin sistemas complejos"
  },

  "cumpleanos_proximos": {
    "descripcion": "si hay datos de cumpleaños, qué hacer con ellos",
    "mensaje_cumpleanios": "texto de WhatsApp para el día del cumpleaños del cliente",
    "beneficio": "regalo o descuento sugerido para cumpleañeros"
  },

  "metricas_a_monitorear": [
    "tasa de retención mensual (% clientes que vuelven)",
    "tiempo promedio entre compras",
    "ticket promedio por segmento",
    "tasa de respuesta a campañas de WhatsApp"
  ],

  "resumen": "3-4 oraciones sobre el estado de la base de clientes y las 2-3 acciones más rentables de esta semana"
}

REGLA FUNDAMENTAL: Toda recomendación debe mostrar:
1. DATOS que la justifican
2. HIPÓTESIS de por qué va a funcionar
3. IMPACTO ESTIMADO en pesos o en clientes recuperados`;

async function ejecutar(cicloId) {
  console.log('[Fidelización] Iniciando análisis de clientes...');

  const db = getFirestore();

  // ── Leer datos de clientes de Firebase ────────────────────────────────────
  let clientes     = [];
  let ventasHist   = [];
  let campañasPrev = [];

  // Colecciones posibles donde pueden estar los clientes
  const coleccionesClientes = ['clientes', 'usuarios', 'customers', 'clients'];
  for (const col of coleccionesClientes) {
    try {
      const snap = await db.collection(col).limit(500).get();
      if (!snap.empty) {
        clientes = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        console.log(`[Fidelización] ${clientes.length} clientes encontrados en '${col}'`);
        break;
      }
    } catch {}
  }

  // Historial de ventas (últimos 3 meses) de nuestra colección
  try {
    const { reader } = require('../tools/firestoreReader');
    // reader puede no estar disponible así, lo hacemos directamente
  } catch {}

  try {
    const ventasSnap = await db.collection('ventas').limit(200).get();
    ventasHist = ventasSnap.docs.map(d => ({ id: d.id, ...d.data() }));
    console.log(`[Fidelización] ${ventasHist.length} registros de ventas`);
  } catch {}

  // Ventas Núcleo si existen
  let ventasNucleo = {};
  try {
    const fecha = new Date().toISOString().split('T')[0];
    const nDoc  = await db.collection('ventas_nucleo').doc(fecha).get();
    if (nDoc.exists) ventasNucleo = nDoc.data();
  } catch {}

  // Campañas anteriores (para no repetir)
  try {
    const campSnap = await db.collection('campañas_fidelizacion')
      .orderBy('created_at', 'desc').limit(10).get();
    campañasPrev = campSnap.docs.map(d => d.data());
  } catch {}

  // ── Análisis básico de la base ──────────────────────────────────────────────
  const ahora     = new Date();
  const hace15    = new Date(ahora - 15 * 24 * 3600 * 1000);
  const hace30    = new Date(ahora - 30 * 24 * 3600 * 1000);
  const hace45    = new Date(ahora - 45 * 24 * 3600 * 1000);

  // Analizar frecuencia si tenemos datos de clientes
  const analisisClientes = _analizarClientes(clientes, ahora, hace15, hace30, hace45);

  // ── Contexto para el LLM ────────────────────────────────────────────────────
  const contexto = {
    fecha_analisis: ahora.toLocaleDateString('es-AR'),
    negocio: {
      nombre:   'Maja Morena',
      modelo:   'Locales propios + franquicias',
      ciudades: 'Villa Carlos Paz, Cosquín, Miramar, Tanti, Alta Gracia, Morteros, Santa Cruz del Lago, Río Cuarto',
    },

    base_de_clientes: {
      total_registros:      clientes.length,
      con_telefono:         clientes.filter(c => c.telefono || c.celular || c.whatsapp).length,
      con_email:            clientes.filter(c => c.email || c.mail).length,
      con_fecha_nacimiento: clientes.filter(c => c.fecha_nacimiento || c.birthday || c.nacimiento).length,
      analisis_frecuencia:  analisisClientes,
      muestra_campos:       clientes.slice(0, 3).map(c => Object.keys(c)),
    },

    historial_ventas: {
      total_registros: ventasHist.length,
      meses_con_datos: [...new Set(ventasHist.map(v => `${v.mes}/${v.ano}`))].slice(0, 6),
    },

    campañas_enviadas_anteriormente: campañasPrev.slice(0, 5).map(c => ({
      nombre: c.nombre, fecha: c.fecha, segmento: c.segmento,
    })),

    contexto_mercado: {
      ticket_promedio_estimado: '$2.500 - $4.000 (empanaderías argentinas 2025)',
      frecuencia_habitual:      '2-4 veces por mes en clientes activos',
      mejor_dia_contacto:       'Martes o miércoles (antes del almuerzo o cena)',
    },

    instrucciones: [
      'Si no hay datos de clientes, explicá cómo empezar a construir la base.',
      'Los mensajes de WhatsApp deben ser cálidos, argentinos, no corporativos.',
      'Priorizá las campañas que más impacto inmediato generen en ventas.',
      'El Club de Beneficios tiene que ser simple — el franquiciado tiene que poder explicarlo en 30 segundos.',
    ],
  };

  // ── LLM ──────────────────────────────────────────────────────────────────────
  let resultado;
  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `DATOS PARA ANÁLISIS DE FIDELIZACIÓN:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'pro',
      temperature: 0.4,
    });
  } catch (e) {
    console.error('[Fidelización] Error LLM:', e.message);
    resultado = _fallback(analisisClientes);
  }

  // ── Guardar campañas en Firebase ────────────────────────────────────────────
  for (const camp of (resultado.campañas_inmediatas || [])) {
    await db.collection('campañas_fidelizacion').add({
      ...camp,
      ciclo_id:       cicloId,
      created_at:     new Date(),
      estado:         'propuesta',
      agente_creador: 'fidelizacion',
    });

    // También en campañas generales para visibilidad en dashboard
    await writer.saveCampaña({
      nombre:           `🎯 ${camp.nombre}`,
      tipo:             'fidelizacion',
      agente_creador:   'fidelizacion',
      descripcion:      camp.impacto_estimado,
      oferta:           { descripcion: camp.objetivo, descuento_pct: null, bonus: null },
      segmento:         camp.segmento_objetivo,
      mensaje_whatsapp: camp.mensaje_completo,
      duracion_dias:    7,
      revenue_esperado: 0,
    }, cicloId);
  }

  // Guardar Club de Beneficios si es nuevo
  if (resultado.club_de_beneficios) {
    await db.collection('configuracion_central').doc('club_beneficios').set({
      ...resultado.club_de_beneficios,
      actualizado_at: new Date(),
    }, { merge: true });
  }

  // Guardar memoria
  await writer.saveAgenteMemoria('fidelizacion', {
    ultimo_ciclo:             new Date(),
    clientes_analizados:      clientes.length,
    campañas_generadas:       (resultado.campañas_inmediatas || []).length,
    resumen:                  resultado.resumen,
    resumen_base:             resultado.resumen_base_clientes,
  });

  console.log(`[Fidelización] ✅ ${resultado.campañas_inmediatas?.length || 0} campañas generadas`);
  console.log(`[Fidelización] Base: ${clientes.length} clientes analizados`);
  return resultado;
}

function _analizarClientes(clientes, ahora, hace15, hace30, hace45) {
  if (!clientes.length) return { sin_datos: true };

  const activos  = clientes.filter(c => {
    const ult = _getUltimaCompra(c);
    return ult && ult > hace15;
  }).length;
  const enRiesgo = clientes.filter(c => {
    const ult = _getUltimaCompra(c);
    return ult && ult <= hace15 && ult > hace30;
  }).length;
  const perdidos = clientes.filter(c => {
    const ult = _getUltimaCompra(c);
    return ult && ult <= hace45;
  }).length;

  return { activos, enRiesgo, perdidos, sin_ultima_compra: clientes.length - activos - enRiesgo - perdidos };
}

function _getUltimaCompra(cliente) {
  const campos = ['ultima_compra', 'last_purchase', 'lastOrder', 'ultimoPedido', 'updatedAt'];
  for (const c of campos) {
    if (cliente[c]) {
      const d = cliente[c].toDate ? cliente[c].toDate() : new Date(cliente[c]);
      if (!isNaN(d)) return d;
    }
  }
  return null;
}

function _fallback(analisis) {
  return {
    resumen_base_clientes: {
      total_clientes_analizados: 0,
      insight_principal: 'No se encontraron datos de clientes en Firebase. Hay que empezar a construir la base.',
    },
    segmentos: [],
    campañas_inmediatas: [{
      nombre:            'Campaña de bienvenida al Club Maja Morena',
      segmento_objetivo: 'Todos los clientes conocidos',
      mensaje_completo:  '¡Hola! 👋 Somos Maja Morena y queremos que seas parte de nuestro Club.\n\nA partir de ahora, por cada compra sumás puntos y conseguís beneficios exclusivos. 🥟\n\n¿Te sumás? Respondé este mensaje con tu nombre y local más cercano.',
      mejor_horario_envio: 'Martes 11hs',
      objetivo:          'construir base de clientes',
      impacto_estimado:  'Base inicial para futuros campañas personalizadas',
      urgencia:          'esta_semana',
    }],
    club_de_beneficios: {
      existe_actualmente: false,
      propuesta: 'Empezar simple: registrar nombre y teléfono en cada venta. Con 5 compras, el cliente recibe una empanada gratis.',
      niveles_sugeridos: [
        { nivel: 'Bronce', criterio: '1-3 compras por mes', beneficio: '5% de descuento' },
        { nivel: 'Plata',  criterio: '4-7 compras por mes', beneficio: '10% de descuento + combo especial' },
        { nivel: 'Oro',    criterio: '+8 compras por mes',  beneficio: '15% + empanada gratis el cumpleaños' },
      ],
      implementacion_simple: 'Comenzar con una planilla en Google Sheets o directamente en Firebase. El encargado registra nombre + teléfono en cada venta.',
    },
    cumpleanos_proximos: {
      descripcion: 'Sin datos de cumpleaños aún. Empezar a pedirlos al registrar clientes.',
      mensaje_cumpleanios: '🎂 ¡Feliz cumple! De parte de toda la familia Maja Morena, hoy te regalamos una empanada gratis. Pasá por el local y mostrá este mensaje. ¡Que lo disfrutes! 🥟🎉',
      beneficio: 'Una empanada gratis el día del cumpleaños',
    },
    metricas_a_monitorear: [
      'Cantidad de clientes nuevos por mes',
      'Porcentaje que vuelve en los primeros 30 días',
      'Ticket promedio por segmento',
    ],
    resumen: 'La base de clientes está en construcción. La prioridad es empezar a registrar nombre y teléfono en cada venta para poder hacer campañas personalizadas. El sistema ya está listo para procesar esos datos en cuanto estén disponibles.',
  };
}

module.exports = { ejecutar };
