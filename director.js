'use strict';
const llm     = require('./tools/llm');
const config  = require('./config');
const writer  = require('./tools/firestoreWriter');
const reader  = require('./tools/firestoreReader');

const SYSTEM_PROMPT = `Sos el Director Comercial de Maja Morena, una cadena de empanaderías argentina con locales en Villa Carlos Paz, Cosquín, Miramar, Tanti, Alta Gracia, Morteros, Villa Santa Cruz del Lago y Río Cuarto.

MODELO DE NEGOCIO — CONTEXTO ESENCIAL:
- La red incluye locales PROPIOS y FRANQUICIAS. Ambos aportan datos al sistema.
- Existe UNA SOLA cuenta de redes sociales para toda la marca. El contenido es centralizado.
- Las campañas de WhatsApp se diseñan centralmente pero cada local las envía a su propia base de clientes.
- Las decisiones que tomás afectan tanto a locales propios (control total) como a franquicias (influencia, no control directo).
- Para franquicias: las recomendaciones tienen que ser claras, simples y fáciles de implementar por un franquiciado.

Tu único objetivo es aumentar la facturación y la rentabilidad de toda la red. Sos un socio estratégico, no un empleado.

Recibís los reportes de tus agentes especializados:
- Analista de Ventas: detecta problemas y tendencias
- Recuperador de Clientes: identifica locales/zonas que necesitan impulso
- Generador de Promociones: crea promos ejecutables
- Generador de Combos: optimiza el ticket promedio
- Inteligencia Comercial: analiza la competencia y redes sociales en internet
- Creador de Contenido: genera contenido para la cuenta única de la marca

Tu trabajo ahora es sintetizar todo, priorizar y decidir las 3-5 acciones más importantes para hoy.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "decision_principal": "la acción más importante que hay que tomar HOY (1 oración directa)",
  "razonamiento": "por qué elegiste esta decisión sobre las demás (2-3 oraciones)",
  "top_acciones": [
    {
      "orden": 1,
      "accion": "descripción clara de qué hacer",
      "quien_ejecuta": "dueño|encargado_local|sistema_automatico",
      "tiempo_para_ejecutar": "hoy|mañana|esta_semana",
      "impacto_esperado": "qué resultado concreto esperás",
      "revenue_potencial": número en pesos
    }
  ],
  "alertas_criticas": [
    {
      "titulo": "título corto",
      "descripcion": "qué está pasando",
      "accion_urgente": "qué hacer ahora"
    }
  ],
  "oportunidad_del_dia": {
    "titulo": "la mejor oportunidad que detectaste hoy",
    "descripcion": "qué es y por qué es buena",
    "accion": "cómo aprovecharla",
    "revenue_estimado": número en pesos
  },
  "mensaje_al_equipo": "mensaje motivacional de 1-2 oraciones para el equipo, en tono de líder cercano",
  "kpi_a_monitorear": "el número más importante para mirar en las próximas 24hs",
  "resumen_ejecutivo": "párrafo de 3-4 oraciones describiendo el estado del negocio y la estrategia del día"
}

Pensá como si tu sueldo dependiera del crecimiento de ventas de Maja Morena.
Sé directo, concreto y práctico. Nada de generalidades.`;

async function ejecutar(cicloId, outputsAgentes) {
  console.log('[Director] Sintetizando reportes de agentes...');

  const memoria = await reader.getAgenteMemoria('director_comercial');

  const contexto = {
    fecha:    new Date().toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
    hora:     new Date().toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' }),
    ciclo_id: cicloId,

    reporte_analista:      outputsAgentes.analista      || {},
    reporte_recuperador:   outputsAgentes.recuperador   || {},
    reporte_promociones:   outputsAgentes.promociones   || {},
    reporte_combos:        outputsAgentes.combos        || {},
    reporte_inteligencia:  outputsAgentes.inteligencia  || {},

    aprendizajes_ciclos_anteriores: memoria.aprendizajes || [],
    acciones_ejecutadas_antes:      memoria.acciones_exitosas || [],
  };

  let resultado;

  try {
    resultado = await llm.ask({
      system: SYSTEM_PROMPT,
      user:   `REPORTES DE AGENTES — CICLO ${cicloId}\n\n${JSON.stringify(contexto, null, 2)}`,
      model:  'pro',
    });
  } catch (e) {
    console.error('[Director] Error LLM:', e.message);
    resultado = _fallbackDirector(outputsAgentes);
  }

  // Guardar oportunidades del director
  if (resultado.oportunidad_del_dia) {
    await writer.saveOportunidad({
      tipo:            'oportunidad_director',
      agente_origen:   'director',
      prioridad:       10,
      local:           'Red completa',
      titulo:          resultado.oportunidad_del_dia.titulo,
      descripcion:     resultado.oportunidad_del_dia.descripcion,
      accion:          resultado.oportunidad_del_dia.accion,
      impacto_estimado: String(resultado.oportunidad_del_dia.revenue_estimado || 0),
      revenue_potencial: resultado.oportunidad_del_dia.revenue_estimado || 0,
    }, cicloId);
  }

  // Guardar alertas críticas del director
  for (const alerta of (resultado.alertas_criticas || [])) {
    await writer.saveAlerta({
      nivel:           'critica',
      tipo:            'decision_director',
      local:           'Red completa',
      titulo:          alerta.titulo,
      descripcion:     alerta.descripcion,
      accion_sugerida: alerta.accion_urgente,
    }, cicloId);
  }

  // Actualizar memoria del director
  await writer.saveAgenteMemoria('director_comercial', {
    ultimo_ciclo:     new Date(),
    decision_tomada:  resultado.decision_principal,
    aprendizajes:     _actualizarAprendizajes(memoria.aprendizajes, resultado),
    acciones_exitosas: memoria.acciones_exitosas || [],
  });

  // Actualizar estado del agente con resumen del director
  await writer.updateEstadoAgente({
    ciclo_actual:         'completado',
    ultimo_ciclo_id:      cicloId,
    ultimo_ciclo_fin:     new Date(),
    decision_director:    resultado.decision_principal,
    resumen_ejecutivo:    resultado.resumen_ejecutivo,
    mensaje_al_equipo:    resultado.mensaje_al_equipo,
    kpi_a_monitorear:     resultado.kpi_a_monitorear,
    top_acciones:         resultado.top_acciones || [],
    alertas_criticas:     resultado.alertas_criticas || [],
  });

  console.log('[Director] ✅ Síntesis completada.');
  console.log('[Director] Decisión principal:', resultado.decision_principal);
  return resultado;
}

function _fallbackDirector(outputs) {
  const alertas = [
    ...(outputs.analista?.alertas    || []),
    ...(outputs.recuperador?.locales_en_riesgo?.map(l => ({
      titulo:       `${l.nombre} necesita recuperación`,
      descripcion:  l.diagnostico,
      accion_urgente: 'Activar campaña de recuperación.',
    })) || []),
  ];

  return {
    decision_principal:  'Revisar los locales con caídas detectadas y activar campañas de recuperación.',
    razonamiento:        'Hay locales con caídas significativas que requieren acción inmediata.',
    top_acciones: [{
      orden: 1,
      accion: 'Activar campañas de WhatsApp para locales con caídas críticas.',
      quien_ejecuta: 'sistema_automatico',
      tiempo_para_ejecutar: 'hoy',
      impacto_esperado: 'Recuperar clientes inactivos en locales con caída.',
      revenue_potencial: 0,
    }],
    alertas_criticas:    alertas.slice(0, 3),
    oportunidad_del_dia: {
      titulo:          'Revisar mix de productos',
      descripcion:     'Hay productos con baja rotación que pueden ser promovidos.',
      accion:          'Lanzar promo de producto con baja rotación.',
      revenue_estimado: 0,
    },
    mensaje_al_equipo:   '¡Vamos equipo! Cada empanada cuenta. Hoy enfocados en atención al cliente.',
    kpi_a_monitorear:    'Ticket promedio del día',
    resumen_ejecutivo:   'Análisis completado. Se detectaron oportunidades de mejora en la red.',
  };
}

function _actualizarAprendizajes(aprendizajesAnteriores, resultado) {
  const nuevo = {
    fecha:    new Date().toISOString().split('T')[0],
    decision: resultado.decision_principal,
    kpi:      resultado.kpi_a_monitorear,
  };
  const lista = [...(aprendizajesAnteriores || []), nuevo];
  return lista.slice(-15); // Guardar solo los últimos 15
}

module.exports = { ejecutar };
