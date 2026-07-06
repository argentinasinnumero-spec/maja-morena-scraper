'use strict';
const llm    = require('../tools/llm');
const calc   = require('../tools/calculos');
const reader = require('../tools/firestoreReader');
const writer = require('../tools/firestoreWriter');
const { getFirestore } = require('firebase-admin/firestore');

const SYSTEM_PROMPT = `Sos el community manager y creador de contenido de Maja Morena, una cadena de empanaderías argentina.

MODELO DE NEGOCIO — MUY IMPORTANTE:
- Maja Morena tiene locales PROPIOS y también FRANQUICIAS en distintas ciudades.
- Existe UNA SOLA cuenta de redes sociales para toda la marca. No hay cuentas por local ni por ciudad.
- El contenido que creás representa a la MARCA COMPLETA, no a un local específico.
- Podés mencionar ciudades para conectar con la audiencia local, pero siempre como parte de la misma familia Maja Morena.
- Los franquiciados NO tienen acceso a publicar en la cuenta oficial — la marca central decide todo el contenido.
- Esto significa que el contenido tiene que ser inclusivo y representar a TODOS los locales a la vez.

CIUDADES DONDE OPERAMOS: Villa Carlos Paz, Cosquín, Villa Santa Cruz del Lago, Miramar, Tanti, Alta Gracia, Morteros, Río Cuarto.

ESTRATEGIA DE CONTENIDO PARA MARCA UNIFICADA:
- Un post puede decir "¿Estás en las sierras? Encontranos en Carlos Paz, Cosquín, Tanti y Santa Cruz" — así incluye varios locales.
- Otro post puede destacar una ciudad específica sin excluir a las demás: "Este finde en Cosquín... ya sabés dónde encontrarnos 🎶"
- El 70% del contenido debe funcionar para cualquier ciudad. El 30% puede ser más localizado.
- Nunca crear contenido que solo sirva para UN local — siempre pensarlo a escala de red.

El estilo de Maja Morena es: CÁLIDO, ARGENTINO, FAMILIAR, CON HUMOR SANO. Nada de inglés, nada de corporativo, nada de fake.

Tu misión: crear contenido concreto y listo para publicar HOY. No ideas vagas — texto real, listo para copiar y pegar.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "posts_instagram": [
    {
      "tipo": "feed|reels|story|carrusel",
      "tema": "de qué trata",
      "caption": "texto completo del post listo para copiar (con emojis, saltos de línea, todo)",
      "hashtags": "#hashtag1 #hashtag2 ... (en una sola línea al final)",
      "idea_visual": "descripción detallada de qué mostrar en la foto/video",
      "momento_publicar": "ej: hoy a las 12hs | mañana a las 19hs",
      "objetivo": "engagement|ventas|branding|fidelizacion",
      "prioridad": número del 1 al 10
    }
  ],
  "stories": [
    {
      "secuencia": número (orden de la historia),
      "tipo": "encuesta|countdown|texto|foto|video_corto",
      "contenido": "qué dice o muestra esta story exactamente",
      "sticker_sugerido": "encuesta|slider|pregunta|countdown o null",
      "pregunta_o_cta": "el texto del sticker interactivo si aplica"
    }
  ],
  "whatsapp_broadcast": {
    "mensaje": "texto completo listo para mandar por WhatsApp a la base de clientes (con emojis, natural)",
    "mejor_horario": "ej: hoy 11hs antes del almuerzo",
    "objetivo": "para qué sirve este mensaje"
  },
  "idea_reels": {
    "titulo": "nombre del reel",
    "guion": "descripción escena por escena de qué grabar (max 60 segundos)",
    "musica_sugerida": "tipo de música o canción argentina que pega",
    "texto_en_pantalla": ["textos que aparecen en el video"],
    "por_que_va_a_funcionar": "explicación de por qué este reel va a tener alcance"
  },
  "calendario_semana": [
    {
      "dia": "Lunes|Martes|...",
      "formato": "feed|story|reels",
      "tema": "tema breve",
      "hora": "HH:hs"
    }
  ],
  "resumen": "2 oraciones explicando la estrategia de contenido de esta semana"
}

Reglas de oro:
- Las captions tienen que sonar HUMANAS, no a bot. Leelas en voz alta antes de escribirlas.
- Los posts de venta tienen que ser el 30% del total. El 70% restante: entretenimiento, detrás de escena, comunidad.
- Usá el voseo argentino siempre.
- Los hashtags: mezcla de masivos (#empanadas, #cordoba) con de nicho (#empanadasartesanales, #comidacasera).
- Priorizá contenido que funcione sin presupuesto — lo que tienen: el producto, el local, el equipo.`;

async function ejecutar(cicloId) {
  console.log('[CreadorContenido] Generando contenido para redes...');

  // ── Leer contexto del negocio ────────────────────────────────────────────
  const ventas  = await reader.getUltimosNMeses(1);
  const precios = await reader.getPrecios();

  const ventasMes  = ventas.length ? ventas : [];
  const mix        = calc.analizarMixProductos(ventasMes);
  const ranking    = calc.rankearLocales(ventasMes);

  // Leer inteligencia de competencia (si existe)
  let inteligencia = {};
  try {
    const db  = getFirestore();
    const doc = await db.collection('agente_memoria').doc('inteligencia_comercial').get();
    if (doc.exists) inteligencia = doc.data();
  } catch {}

  // Día y horario actual
  const ahora    = new Date();
  const diasSem  = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];
  const diaActual = diasSem[ahora.getDay()];
  const hora      = ahora.getHours();

  // Detectar contexto especial
  const esFinde   = ahora.getDay() === 5 || ahora.getDay() === 6 || ahora.getDay() === 0;
  const esMediodia = hora >= 11 && hora <= 14;
  const esNoche    = hora >= 19 && hora <= 23;

  // Top producto de la semana
  const topProducto = mix[0]?.nombre || 'empanadas';
  const productoBajo = mix.find(p => p.porcentaje < 3 && p.porcentaje > 0)?.nombre || null;

  // Ticket promedio
  const totalV = ranking.reduce((s, l) => s + l.ventas, 0);
  const totalT = ranking.reduce((s, l) => s + l.transacciones, 0);
  const ticket = totalT > 0 ? Math.round(totalV / totalT) : 0;

  const contexto = {
    fecha:         ahora.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
    dia_semana:    diaActual,
    es_fin_de_semana: esFinde,
    hora_actual:   hora,
    contexto_horario: esMediodia ? 'zona_almuerzo' : esNoche ? 'zona_cena' : 'horario_normal',

    negocio: {
      nombre:      'Maja Morena',
      rubro:       'Empanaderías artesanales argentinas',
      locales:     ranking.length,
      ciudades_con_locales: [
        'Villa Carlos Paz', 'Río Cuarto', 'Alta Gracia', 'Morteros',
        'Villa Santa Cruz del Lago', 'Cosquín', 'Miramar', 'Tanti',
      ],
      contexto_ciudades: {
        'Villa Carlos Paz': 'ciudad turística serrana, mucho movimiento todo el año',
        'Cosquín': 'ciudad del folklore, turismo en enero, mucha identidad local',
        'Villa Santa Cruz del Lago': 'turismo de playa en lago San Roque, verano fuerte',
        'Miramar': 'pueblo tranquilo junto al lago, clientela fiel',
        'Tanti': 'pueblo serrano pequeño, turismo aventura y familia',
        'Alta Gracia': 'ciudad con historia, turismo cultural, buena clase media',
        'Morteros': 'ciudad agrícola, clientela local muy fiel',
        'Río Cuarto': 'ciudad grande, mercado amplio, más competencia formal',
      },
      instagram:   '@majamorenaempanadas',
      canales_venta: ['mostrador', 'delivery', 'mesas'],
    },

    datos_ventas: {
      producto_estrella:    topProducto,
      producto_a_impulsar:  productoBajo,
      ticket_promedio:      calc.formatPesos(ticket),
      top_locales:          ranking.slice(0, 3).map(l => l.nombre),
    },

    inteligencia_competencia: {
      oportunidad_vs_competencia: inteligencia.oportunidad_detectada || '',
      acciones_sugeridas:         (inteligencia.acciones_pendientes || []).map(a => a.accion).slice(0, 3),
    },

    instrucciones_creativas: [
      `Hoy es ${diaActual}${esFinde ? ' — FIN DE SEMANA. Las ciudades turísticas de la red (Carlos Paz, Cosquín, Santa Cruz del Lago) están llenas. Creá contenido que hable a TODA la red pero que resuene especialmente con quienes están de paseo por las sierras.' : ''}.`,
      'RECORDÁ: una sola cuenta de redes para toda la marca. El contenido tiene que funcionar para alguien en Morteros Y para alguien en Carlos Paz al mismo tiempo.',
      productoBajo
        ? `El producto "${productoBajo}" necesita impulso en toda la red — creá al menos 1 post que lo destaque sin mencionar un local específico.`
        : 'Mix de productos equilibrado — enfocate en el producto estrella y en generar antojo a nivel marca.',
      'Estrategia de ciudades en el calendario: alternár entre posts genéricos de marca y posts que nombren 2-3 ciudades juntas ("si estás en las sierras, ya sabés dónde encontrarnos").',
      'Incluí al menos 1 idea de Reels que funcione para la marca completa (proceso, detrás de escena, equipo).',
      'El mensaje de WhatsApp lo va a enviar cada local a su propia base. Escribilo en primera persona del local pero con identidad de marca.',
      'El calendario semanal debe tener 5-7 publicaciones que cubran distintos momentos y mensajes, sin repetir la misma ciudad dos veces seguidas.',
    ],
  };

  // ── Llamar al LLM ────────────────────────────────────────────────────────
  let resultado;
  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `DATOS PARA CREAR CONTENIDO:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'pro',       // GPT-4o para contenido creativo
      temperature: 0.8,         // Más creatividad
    });
  } catch (e) {
    console.error('[CreadorContenido] Error LLM:', e.message);
    resultado = _fallback(topProducto, diaActual);
  }

  // ── Guardar en Firestore ─────────────────────────────────────────────────
  const db = getFirestore();
  await db.collection('contenido_redes').add({
    ciclo_id:       cicloId,
    created_at:     new Date(),
    estado:         'borrador',   // Necesita aprobación del dueño
    fecha_generado: ahora.toLocaleDateString('es-AR'),
    posts_instagram: resultado.posts_instagram || [],
    stories:         resultado.stories         || [],
    whatsapp_broadcast: resultado.whatsapp_broadcast || {},
    idea_reels:      resultado.idea_reels       || {},
    calendario_semana: resultado.calendario_semana || [],
    resumen:         resultado.resumen          || '',
    contexto_usado:  {
      dia:        diaActual,
      producto:   topProducto,
      ticket:     calc.formatPesos(ticket),
    },
  });

  // Guardar el mejor post como campaña para visibilidad en dashboard
  const mejorPost = (resultado.posts_instagram || []).sort((a, b) => b.prioridad - a.prioridad)[0];
  if (mejorPost) {
    await writer.saveCampaña({
      nombre:          `📸 Post: ${mejorPost.tema}`,
      tipo:            'contenido_redes',
      agente_creador:  'creador_contenido',
      descripcion:     mejorPost.idea_visual,
      oferta:          { descripcion: mejorPost.caption.slice(0, 120) + '...', descuento_pct: null, bonus: null },
      segmento:        'Instagram — ' + mejorPost.tipo,
      mensaje_whatsapp: resultado.whatsapp_broadcast?.mensaje || '',
      duracion_dias:    7,
      revenue_esperado: 0,
      datos_extra: {
        caption_completo: mejorPost.caption,
        hashtags:         mejorPost.hashtags,
        momento:          mejorPost.momento_publicar,
        tipo_post:        mejorPost.tipo,
        idea_visual:      mejorPost.idea_visual,
        reels:            resultado.idea_reels,
        calendario:       resultado.calendario_semana,
      },
    }, cicloId);
  }

  // Guardar memoria del agente
  await writer.saveAgenteMemoria('creador_contenido', {
    ultimo_ciclo:      new Date(),
    posts_generados:   (resultado.posts_instagram || []).length,
    ultimo_resumen:    resultado.resumen,
    ultimo_producto:   topProducto,
  });

  console.log(`[CreadorContenido] ✅ ${resultado.posts_instagram?.length || 0} posts + ${resultado.stories?.length || 0} stories + 1 reel generados`);
  return resultado;
}

function _fallback(producto, dia) {
  return {
    posts_instagram: [{
      tipo:          'feed',
      tema:          `Las mejores ${producto} de Córdoba`,
      caption:       `¿Sabías que nuestras ${producto} se hacen a mano todos los días?\n\nSin conservantes, sin apuros. Solo el sabor de siempre. 🥟\n\n¿Cuándo fue la última vez que te comiste una empanada de Maja Morena? 👇`,
      hashtags:      '#empanadas #córdoba #comidacasera #majamorena #empanadasartesanales #cordobaargentina',
      idea_visual:   `Foto de las ${producto} recién salidas del horno, con vapor, sobre una tabla de madera rústica.`,
      momento_publicar: `${dia} a las 12hs`,
      objetivo:      'engagement',
      prioridad:     8,
    }],
    stories: [{
      secuencia:     1,
      tipo:          'encuesta',
      contenido:     '¿Qué preferís para el almuerzo de hoy?',
      sticker_sugerido: 'encuesta',
      pregunta_o_cta: 'Empanadas 🥟 vs Pizza 🍕',
    }],
    whatsapp_broadcast: {
      mensaje:       `¡Hola! 👋 Hoy en Maja Morena tenemos los clásicos de siempre fresquitos. Pasá a buscarte las tuyas o pedí por delivery. 🥟`,
      mejor_horario: 'hoy 11hs',
      objetivo:      'activar pedidos del almuerzo',
    },
    idea_reels: {
      titulo:          'El proceso de nuestras empanadas',
      guion:           'Toma 1: manos amasando. Toma 2: relleno. Toma 3: el repulgue. Toma 4: entran al horno. Toma 5: salen doradas. Toma 6: cliente comiendo feliz.',
      musica_sugerida: 'Cumbia villera clásica o folklore argentino instrumental',
      texto_en_pantalla: ['Hechas a mano', 'Todos los días', 'En Maja Morena'],
      por_que_va_a_funcionar: 'El proceso artesanal genera confianza y antojo simultáneamente.',
    },
    calendario_semana: [],
    resumen: `Estrategia enfocada en mostrar el proceso artesanal y generar antojo orgánico. El ${dia} es ideal para contenido de almuerzo.`,
  };
}

module.exports = { ejecutar };
