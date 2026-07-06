'use strict';
const llm     = require('../tools/llm');
const scraper = require('../tools/webScraper');
const writer  = require('../tools/firestoreWriter');
const reader  = require('../tools/firestoreReader');
const calc    = require('../tools/calculos');

// ─── Locales propios de Maja Morena con foco ────────────────────────────────
const LOCALES_FOCO = [
  { ciudad: 'Villa Carlos Paz',        zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Villa Carlos Paz empanadas' },
  { ciudad: 'Río Cuarto',              zona: 'Río Cuarto',       busqueda_local: 'Maja Morena Río Cuarto empanadas' },
  { ciudad: 'Alta Gracia',             zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Alta Gracia empanadas' },
  { ciudad: 'Morteros',                zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Morteros empanadas' },
  { ciudad: 'Villa Santa Cruz del Lago', zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Santa Cruz del Lago empanadas' },
  { ciudad: 'Cosquín',                 zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Cosquín empanadas' },
  { ciudad: 'Miramar',                 zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Miramar Córdoba empanadas' },
  { ciudad: 'Tanti',                   zona: 'Córdoba Interior', busqueda_local: 'Maja Morena Tanti empanadas' },
];

// ─── Competidores directos por ciudad ────────────────────────────────────────
const COMPETIDORES_BASE = {
  'Villa Carlos Paz': [
    'empanadas Villa Carlos Paz',
    'La Cocina empanadas Carlos Paz',
    'Las Delicias empanadas Carlos Paz',
    'empanaderías Villa Carlos Paz delivery',
    'pizza empanadas Carlos Paz turismo',
  ],
  'Río Cuarto': [
    'empanadas Río Cuarto',
    'La Familia empanadas Río Cuarto',
    'Los Compadres empanadas Río Cuarto',
    'empanaderías Río Cuarto delivery PedidosYa',
    'rotisería empanadas Río Cuarto',
  ],
  'Alta Gracia': [
    'empanadas Alta Gracia Córdoba',
    'La Ranchada empanadas Alta Gracia',
    'rotisería Alta Gracia empanadas',
    'delivery empanadas Alta Gracia',
  ],
  'Morteros': [
    'empanadas Morteros Córdoba',
    'rotisería Morteros empanadas delivery',
    'comida rápida Morteros Córdoba',
  ],
  'Villa Santa Cruz del Lago': [
    'empanadas Santa Cruz del Lago Córdoba',
    'delivery empanadas Santa Cruz del Lago',
    'gastronomía Santa Cruz del Lago',
  ],
  'Cosquín': [
    'empanadas Cosquín Córdoba',
    'rotisería Cosquín empanadas',
    'delivery empanadas Cosquín turismo',
    'comida Cosquín festival folklore',
  ],
  'Miramar': [
    'empanadas Miramar Córdoba',
    'delivery empanadas Miramar San Roque',
    'gastronomía Miramar lago San Roque',
  ],
  'Tanti': [
    'empanadas Tanti Córdoba',
    'delivery empanadas Tanti',
    'rotisería Tanti Sierra Chica',
  ],
};

// ─── Redes sociales de Maja Morena ────────────────────────────────────────
const MAJA_MORENA_SOCIAL = {
  instagram: 'majamorenaempanadas',
  busqueda_web: 'Maja Morena empanadas Córdoba',
};

const SYSTEM_PROMPT = `Sos el especialista en inteligencia comercial de Maja Morena, una cadena de empanaderías argentina.

Maja Morena tiene locales propios en estas ciudades clave:
- Villa Carlos Paz (ciudad turística serrana, alta competencia en temporada)
- Río Cuarto (ciudad grande, mercado más maduro)
- Alta Gracia (ciudad intermedia, turismo histórico)
- Morteros (ciudad chica, mercado local cautivo)
- Villa Santa Cruz del Lago (destino turístico, lago San Roque)
- Cosquín (ciudad turística, folklore, temporada alta enero)
- Miramar (ciudad pequeña, lago San Roque)
- Tanti (pueblo serrano, turismo aventura)

Tu misión: analizar la competencia CIUDAD POR CIUDAD y detectar qué está pasando en cada mercado local.

Recibís datos scrapeados de internet. Pueden ser incompletos — usá tu conocimiento del mercado gastronómico argentino para completar donde falten datos.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "resumen_competencia": {
    "amenaza_principal": "el mayor riesgo competitivo ahora mismo, específico con ciudad",
    "oportunidad_detectada": "la mejor oportunidad vs competencia, específica",
    "tendencia_mercado": "qué está demandando el mercado en estas ciudades"
  },
  "analisis_por_ciudad": [
    {
      "ciudad": "nombre de la ciudad",
      "tipo_mercado": "turistico|ciudad_grande|ciudad_chica|pueblo",
      "visibilidad_maja_morena": "alta|media|baja",
      "competencia_detectada": ["nombres de competidores encontrados"],
      "nivel_amenaza_competencia": número del 1 al 10,
      "oportunidad_local": "qué puede hacer Maja Morena específicamente en esta ciudad",
      "accion_prioritaria": "la acción más concreta e inmediata para esta ciudad"
    }
  ],
  "competidores": [
    {
      "nombre": "nombre del competidor",
      "ciudad": "en qué ciudad opera",
      "fortalezas": ["lista de fortalezas"],
      "debilidades": ["lista de debilidades"],
      "nivel_amenaza": número del 1 al 10,
      "accion_sugerida": "qué hacer Maja Morena frente a este"
    }
  ],
  "analisis_redes_sociales": {
    "maja_morena_presencia": "estado de presencia online de Maja Morena",
    "ciudades_con_baja_visibilidad": ["ciudades donde Maja Morena no aparece bien en búsquedas"],
    "gaps_detectados": ["cosas que la competencia hace y Maja Morena no"],
    "hashtags_por_ciudad": {
      "Villa Carlos Paz": ["#hashtags relevantes"],
      "Cosquín": ["#hashtags relevantes"],
      "Río Cuarto": ["#hashtags relevantes"]
    }
  },
  "acciones_inmediatas": [
    {
      "ciudad": "ciudad específica o 'todas'",
      "accion": "descripción concreta de qué hacer",
      "urgencia": "hoy|esta_semana|este_mes",
      "impacto_esperado": "resultado concreto",
      "responsable": "dueño|marketing|encargado_local"
    }
  ],
  "insight_pricing": "observación sobre precios de competencia vs Maja Morena en estas ciudades",
  "resumen": "párrafo de 3-4 oraciones: estado competitivo general y las 2-3 acciones más urgentes"
}

MODELO DE NEGOCIO — CRÍTICO PARA TUS RECOMENDACIONES:
- Maja Morena tiene locales PROPIOS y FRANQUICIAS.
- Existe UNA SOLA cuenta de redes sociales para toda la marca. NUNCA recomendés crear cuentas separadas por local o ciudad.
- Las acciones de redes siempre son a nivel marca, no a nivel local.
- Lo que SÍ puede tener cada local por separado: Google My Business (perfil de Google Maps), que es diferente a redes sociales.
- Para franquiciados: las recomendaciones tienen que ser simples y ejecutables sin mucho conocimiento técnico.

IMPORTANTE:
- Ciudades turísticas (Carlos Paz, Cosquín, Santa Cruz del Lago, Miramar, Tanti): la competencia varía mucho entre temporada alta y baja.
- En ciudades chicas (Morteros, Tanti, Miramar): el perfil de Google My Business de cada local es la herramienta más importante, no las redes.
- Sé específico. "Actualizar el perfil de Google Maps del local de Carlos Paz con fotos nuevas" es mejor que "mejorar presencia digital".
- Nunca sugieras crear una cuenta de Instagram o Facebook por ciudad o local.`;

async function ejecutar(cicloId) {
  console.log('[InteligenciaComercial] Iniciando análisis de competencia y redes...');

  const resultadosWeb = {};

  // ── 1. Buscar información de Maja Morena en internet ──────────────────────
  console.log('[InteligenciaComercial] Buscando presencia digital de Maja Morena...');
  try {
    const [busquedaMaja, instagramMaja] = await Promise.all([
      scraper.buscar(`${MAJA_MORENA_SOCIAL.busqueda_web} instagram facebook opiniones`, 8),
      scraper.fetchInstagramPerfil(MAJA_MORENA_SOCIAL.instagram),
    ]);
    resultadosWeb.maja_morena = {
      busqueda:  busquedaMaja,
      instagram: instagramMaja,
    };
    console.log(`[InteligenciaComercial] Maja Morena: ${busquedaMaja.length} resultados web`);
  } catch (e) {
    console.warn('[InteligenciaComercial] Error buscando Maja Morena:', e.message);
    resultadosWeb.maja_morena = {};
  }

  // ── 2. Buscar presencia propia en cada ciudad foco ────────────────────────
  console.log('[InteligenciaComercial] Verificando presencia de Maja Morena en cada ciudad...');
  resultadosWeb.presencia_propia = {};

  for (const local of LOCALES_FOCO) {
    try {
      const res = await scraper.buscar(
        `${local.busqueda_local} opiniones google maps calificación`,
        4
      );
      resultadosWeb.presencia_propia[local.ciudad] = {
        ciudad: local.ciudad,
        zona:   local.zona,
        resultados_encontrados: res.length,
        resultados: res,
      };
      console.log(`[InteligenciaComercial] Maja Morena en ${local.ciudad}: ${res.length} resultados`);
    } catch (e) {
      resultadosWeb.presencia_propia[local.ciudad] = { ciudad: local.ciudad, error: e.message };
    }
  }

  // ── 3. Buscar competidores ciudad por ciudad ───────────────────────────────
  console.log('[InteligenciaComercial] Analizando competencia ciudad por ciudad...');
  resultadosWeb.competencia = {};

  for (const [ciudad, competidores] of Object.entries(COMPETIDORES_BASE)) {
    // Buscar en paralelo (máx 3 por ciudad)
    const promises = competidores.slice(0, 3).map(async (comp) => {
      try {
        const resultados = await scraper.buscar(`${comp} opiniones delivery precios menú`, 4);
        return { competidor: comp, ciudad, resultados };
      } catch (e) {
        return { competidor: comp, ciudad, resultados: [], error: e.message };
      }
    });

    const resultadosCiudad = await Promise.all(promises);
    resultadosWeb.competencia[ciudad] = resultadosCiudad;
    console.log(`[InteligenciaComercial] ${ciudad}: ${resultadosCiudad.length} competidores`);
  }

  // ── 3. Buscar tendencias del mercado ──────────────────────────────────────
  console.log('[InteligenciaComercial] Buscando tendencias del mercado...');
  try {
    const [tendencias, delivery, redes] = await Promise.all([
      scraper.buscar('tendencias empanaderías Argentina 2025 delivery', 5),
      scraper.buscar('PedidosYa Rappi empanadas Córdoba más pedidos', 5),
      scraper.buscar('empanaderías Córdoba Instagram viral mejores', 5),
    ]);
    resultadosWeb.tendencias = { tendencias, delivery, redes };
    console.log('[InteligenciaComercial] Tendencias: datos obtenidos');
  } catch (e) {
    console.warn('[InteligenciaComercial] Error en tendencias:', e.message);
    resultadosWeb.tendencias = {};
  }

  // ── 4. Obtener datos internos para contexto ────────────────────────────────
  let ventasResumen = {};
  try {
    const ventas  = await reader.getUltimosNMeses(1);
    const ranking = calc.rankearLocales(ventas);
    const mix     = calc.analizarMixProductos(ventas);
    ventasResumen = {
      total_locales:  ranking.length,
      top_local:      ranking[0]?.nombre || 'N/A',
      ticket_promedio: ranking.length
        ? calc.formatPesos(Math.round(
            ranking.reduce((s, l) => s + l.ventas, 0) /
            Math.max(ranking.reduce((s, l) => s + l.transacciones, 0), 1)
          ))
        : 'N/A',
      producto_estrella: mix[0]?.nombre || 'Empanadas',
    };
  } catch (e) {
    console.warn('[InteligenciaComercial] Sin datos internos:', e.message);
  }

  // ── 5. Sintetizar con GPT-4o ───────────────────────────────────────────────
  console.log('[InteligenciaComercial] Sintetizando con IA...');

  const contexto = {
    fecha_analisis:   new Date().toLocaleDateString('es-AR'),
    maja_morena: {
      descripcion:    'Cadena de empanaderías argentina, locales propios en estas ciudades clave',
      ciudades_foco:  LOCALES_FOCO.map(l => l.ciudad),
      productos:      ['empanadas', 'pizzas', 'caseritas', 'hamburguesas', 'bebidas'],
      canales:        ['mostrador', 'delivery', 'mesas'],
      datos_internos: ventasResumen,
    },
    presencia_propia_por_ciudad: resultadosWeb.presencia_propia,
    competencia_por_ciudad:      resultadosWeb.competencia,
    tendencias_mercado:          resultadosWeb.tendencias,
    instrucciones_especiales: [
      'Analizá CIUDAD POR CIUDAD. Cada una tiene su propia dinámica y competencia.',
      'Villa Carlos Paz y Cosquín son ciudades turísticas — la competencia en verano/feriados es distinta.',
      'Río Cuarto es ciudad grande — más competidores formales y cadenas.',
      'Morteros, Miramar, Tanti y Santa Cruz del Lago son ciudades chicas — la presencia digital gana más.',
      'Detectá en cuáles ciudades Maja Morena tiene baja visibilidad online vs la competencia.',
      'Priorizá acciones por ciudad según urgencia real.',
    ],
  };

  let resultado;
  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `DATOS DE INTELIGENCIA COMERCIAL:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'pro',
      temperature: 0.4,
    });
  } catch (e) {
    console.error('[InteligenciaComercial] Error LLM:', e.message);
    resultado = _fallback(resultadosWeb);
  }

  // ── 6. Guardar resultados en Firestore ────────────────────────────────────
  // Guardar como oportunidades de alto impacto
  for (const accion of (resultado.acciones_inmediatas || [])) {
    if (accion.urgencia === 'hoy' || accion.urgencia === 'esta_semana') {
      await writer.saveOportunidad({
        tipo:            'inteligencia_competencia',
        agente_origen:   'inteligencia_comercial',
        prioridad:       accion.urgencia === 'hoy' ? 9 : 7,
        local:           'Red completa',
        titulo:          accion.accion.slice(0, 80),
        descripcion:     accion.impacto_esperado,
        accion:          accion.accion,
        impacto_estimado: accion.impacto_esperado,
        revenue_potencial: 0,
        datos_soporte:   accion,
      }, cicloId);
    }
  }

  // Guardar reporte completo en memoria del agente
  await writer.saveAgenteMemoria('inteligencia_comercial', {
    ultimo_analisis:       new Date(),
    amenaza_principal:     resultado.resumen_competencia?.amenaza_principal,
    oportunidad_detectada: resultado.resumen_competencia?.oportunidad_detectada,
    competidores_analizados: (resultado.competidores || []).length,
    ultimo_resumen:        resultado.resumen,
    acciones_pendientes:   resultado.acciones_inmediatas || [],
  });

  console.log(`[InteligenciaComercial] ✅ ${resultado.competidores?.length || 0} competidores analizados`);
  console.log(`[InteligenciaComercial] Amenaza: ${resultado.resumen_competencia?.amenaza_principal}`);
  return resultado;
}

function _fallback(datos) {
  return {
    resumen_competencia: {
      amenaza_principal:    'No se pudo analizar la competencia en este ciclo.',
      oportunidad_detectada: 'Mejorar presencia digital propia.',
      tendencia_mercado:    'Delivery sigue creciendo en el sector gastronómico.',
    },
    competidores: [],
    analisis_redes_sociales: {
      maja_morena_presencia: 'Análisis pendiente.',
      gaps_detectados:       ['Frecuencia de publicaciones', 'Contenido de video/Reels'],
      contenido_sugerido:    [
        'Video del proceso de elaboración de empanadas',
        'Promos del día con imagen atractiva',
        'Testimonios de clientes satisfechos',
      ],
      hashtags_recomendados: ['#empanadasCordoba', '#MajaMorena', '#empanadas', '#Cordoba', '#comidacasera'],
    },
    acciones_inmediatas: [{
      accion:          'Revisar y actualizar perfiles de Instagram y Google My Business de todos los locales.',
      urgencia:        'esta_semana',
      impacto_esperado: 'Mayor visibilidad digital y captación de nuevos clientes.',
      responsable:     'dueño',
    }],
    insight_pricing:  'No se pudo obtener datos de pricing de la competencia.',
    resumen:          'Análisis de competencia parcial. Se requiere más datos para conclusiones sólidas.',
  };
}

module.exports = { ejecutar };
