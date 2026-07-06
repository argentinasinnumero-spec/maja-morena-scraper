'use strict';
const llm    = require('../tools/llm');
const writer = require('../tools/firestoreWriter');
const reader = require('../tools/firestoreReader');
const { getFirestore } = require('firebase-admin/firestore');

const SYSTEM_PROMPT = `Sos el asistente personal del dueño de Maja Morena, una cadena de empanaderías argentinas.

Tu trabajo es TRADUCIR todo lo que dicen los otros agentes a un lenguaje simple, claro y accionable para alguien que no es experto en tecnología, marketing digital ni análisis de datos.

El dueño es un empresario gastronómico que entiende su negocio perfectamente, pero no está familiarizado con términos técnicos de redes sociales, métricas digitales ni jerga de sistemas.

Tu tono: cercano, directo, como si le explicaras a un amigo inteligente. Sin condescendencia. Sin tecnicismos. Sin vueltas.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "saludo_del_dia": "saludo personalizado según el día/hora (1 oración cálida y directa)",

  "resumen_para_humanos": "explicación en 3-4 oraciones de QUÉ ESTÁ PASANDO en el negocio ahora mismo, sin términos técnicos. Como si se lo contaras a alguien en un café.",

  "diagnosticos": [
    {
      "titulo": "nombre claro del problema o situación (sin tecnicismos)",
      "que_esta_pasando": "explicación simple de qué detectó el sistema (máx 2 oraciones, lenguaje llano)",
      "por_que_importa": "por qué esto afecta a la caja o al negocio (concreto, en pesos o en clientes si es posible)",
      "soluciones": [
        {
          "opcion": "A — La más fácil",
          "que_hacer": "exactamente qué hacer, paso a paso, en lenguaje simple",
          "tiempo_para_implementar": "ej: 30 minutos hoy",
          "costo_aproximado": "gratis | $X | requiere contratar a alguien",
          "resultado_esperado": "qué vas a ver diferente en cuánto tiempo"
        },
        {
          "opcion": "B — La más efectiva",
          "que_hacer": "exactamente qué hacer",
          "tiempo_para_implementar": "ej: esta semana",
          "costo_aproximado": "gratis | $X",
          "resultado_esperado": "qué vas a ver diferente en cuánto tiempo"
        },
        {
          "opcion": "C — La más completa (largo plazo)",
          "que_hacer": "exactamente qué hacer",
          "tiempo_para_implementar": "ej: este mes",
          "costo_aproximado": "inversión estimada",
          "resultado_esperado": "qué vas a ver diferente en cuánto tiempo"
        }
      ],
      "que_medir": "el número concreto que tenés que mirar para saber si funcionó (ej: ventas del jueves en Carlos Paz, followers nuevos esta semana)",
      "urgencia": "ahora|esta_semana|este_mes"
    }
  ],

  "glosario_del_dia": [
    {
      "termino": "término técnico que aparece en los reportes",
      "significado_simple": "qué significa en castellano llano",
      "ejemplo_concreto": "un ejemplo de cómo aplica a Maja Morena específicamente"
    }
  ],

  "pregunta_del_dia": "una pregunta que el dueño debería hacerse hoy sobre su negocio (para generar reflexión estratégica)",

  "numero_del_dia": {
    "numero": "el número más importante a recordar hoy (puede ser ventas, ticket, porcentaje)",
    "que_significa": "qué significa ese número en palabras simples",
    "es_bueno_o_malo": "bueno|malo|neutro",
    "que_hacer_con_el": "qué acción concreta genera ese número"
  },

  "proximos_pasos": [
    "acción 1 — concreta, con responsable y plazo",
    "acción 2",
    "acción 3"
  ]
}

REGLAS DE ORO:
- Nunca uses: KPI, engagement, funnel, conversión, CTR, ROI, algoritmo, scraping, LLM, prompt, token.
- En cambio decí: ventas, clientes, alcance, retorno, sistema, análisis.
- Si algo costó plata o puede generar plata, ponelo en números reales de pesos argentinos.
- Cada diagnóstico SIEMPRE tiene 3 opciones de solución (fácil / efectiva / completa).
- El tono es el de un socio de negocios experimentado hablando sin tecnicismos.`;

async function ejecutar(cicloId) {
  console.log('[AsistentePersonal] Compilando resumen para el dueño...');

  const db = getFirestore();

  // Leer todos los outputs de los otros agentes de este ciclo o el más reciente
  let contextoAgentes = {};

  try {
    // Estado del agente (tiene la síntesis del director)
    const estadoSnap = await db.collection('agente_estado').limit(1).get();
    if (!estadoSnap.empty) contextoAgentes.estado_director = estadoSnap.docs[0].data();

    // Últimas alertas
    const alertasSnap = await db.collection('alertas')
      .where('estado', '==', 'nueva')
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();
    contextoAgentes.alertas = alertasSnap.docs.map(d => d.data());

    // Últimas oportunidades
    const opsSnap = await db.collection('oportunidades')
      .where('estado', '==', 'pendiente')
      .orderBy('prioridad', 'desc')
      .limit(10)
      .get();
    contextoAgentes.oportunidades = opsSnap.docs.map(d => d.data());

    // Campañas propuestas
    const campSnap = await db.collection('campañas')
      .where('estado', '==', 'propuesta')
      .orderBy('created_at', 'desc')
      .limit(5)
      .get();
    contextoAgentes.campanas = campSnap.docs.map(d => d.data());

    // Último contenido de redes
    const contSnap = await db.collection('contenido_redes')
      .orderBy('created_at', 'desc')
      .limit(1)
      .get();
    if (!contSnap.empty) contextoAgentes.contenido_redes = contSnap.docs[0].data();

    // Inteligencia de competencia
    const intelDoc = await db.collection('agente_memoria').doc('inteligencia_comercial').get();
    if (intelDoc.exists) contextoAgentes.inteligencia_competencia = intelDoc.data();

  } catch (e) {
    console.warn('[AsistentePersonal] Error leyendo contexto:', e.message);
  }

  const ahora   = new Date();
  const hora    = ahora.getHours();
  const saludoHora = hora < 12 ? 'Buenos días' : hora < 19 ? 'Buenas tardes' : 'Buenas noches';
  const diasSem = ['domingo','lunes','martes','miércoles','jueves','viernes','sábado'];

  const contexto = {
    fecha:       ahora.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long' }),
    hora_actual: hora,
    saludo_base: saludoHora,
    dia_semana:  diasSem[ahora.getDay()],
    es_finde:    ahora.getDay() === 0 || ahora.getDay() === 6,

    negocio: {
      nombre:   'Maja Morena',
      ciudades: 'Villa Carlos Paz, Cosquín, Miramar, Tanti, Alta Gracia, Morteros, Villa Santa Cruz del Lago y Río Cuarto',
      rubro:    'Empanaderías artesanales',
      modelo:   'Locales propios + franquicias. Una sola cuenta de redes sociales para toda la marca.',
      importante: 'El dueño gestiona tanto locales propios (control total) como franquiciados (socios). Las campañas de redes son centralizadas — una sola voz para toda la marca.',
    },

    reportes_de_los_agentes: contextoAgentes,

    instruccion: [
      'Traducí todo lo que encontrás en los reportes a lenguaje simple.',
      'Si hay alertas sobre locales específicos, aclará si es un local propio (el dueño puede actuar directamente) o si es una franquicia (hay que hablar con el franquiciado y darle lineamientos claros).',
      'Para el contenido de redes: recordá siempre que es UNA SOLA cuenta para toda la marca. Nunca sugieras crear cuentas separadas por local.',
      'Para las campañas de WhatsApp: explicá que cada local (propio o franquicia) las envía a su propia lista de clientes, pero el mensaje lo diseña la casa central.',
      'Si hay diagnósticos de locales con bajo rendimiento, diferenciá: local propio = acción directa del dueño; franquicia = reunión con el franquiciado.',
      'Inventá el glosario con los términos técnicos más raros que aparezcan en los reportes.',
    ].join(' '),
  };

  let resultado;
  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `INFORMACIÓN DEL SISTEMA PARA TRADUCIR:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'pro',
      temperature: 0.5,
    });
  } catch (e) {
    console.error('[AsistentePersonal] Error LLM:', e.message);
    resultado = _fallback(contextoAgentes, saludoHora);
  }

  // Guardar en Firestore
  await db.collection('asistente_personal').add({
    ciclo_id:   cicloId,
    created_at: new Date(),
    fecha:      ahora.toLocaleDateString('es-AR'),
    ...resultado,
  });

  // Guardar memoria
  await writer.saveAgenteMemoria('asistente_personal', {
    ultimo_ciclo:   new Date(),
    ultimo_resumen: resultado.resumen_para_humanos,
    diagnosticos:   (resultado.diagnosticos || []).length,
  });

  console.log(`[AsistentePersonal] ✅ ${resultado.diagnosticos?.length || 0} diagnósticos traducidos`);
  return resultado;
}

function _fallback(ctx, saludo) {
  const alertas = ctx.alertas || [];
  return {
    saludo_del_dia: `${saludo}, dueño. El sistema trabajó toda la noche y tiene novedades para vos.`,
    resumen_para_humanos: `El sistema analizó tus ${alertas.length} situaciones más importantes. En líneas generales, el negocio está operando pero hay algunas ciudades y productos que necesitan atención esta semana.`,
    diagnosticos: alertas.slice(0, 2).map(a => ({
      titulo: a.titulo || 'Situación detectada',
      que_esta_pasando: a.descripcion || 'El sistema detectó una anomalía en las ventas.',
      por_que_importa: 'Puede afectar la facturación si no se atiende esta semana.',
      soluciones: [
        { opcion: 'A — La más fácil', que_hacer: 'Llamar al encargado del local y preguntar qué está pasando.', tiempo_para_implementar: 'Hoy', costo_aproximado: 'Gratis', resultado_esperado: 'Entender la causa en 24hs.' },
        { opcion: 'B — La más efectiva', que_hacer: a.accion_sugerida || 'Revisar las ventas de la semana en ese local.', tiempo_para_implementar: 'Esta semana', costo_aproximado: 'Gratis', resultado_esperado: 'Mejora visible en 7 días.' },
        { opcion: 'C — La más completa', que_hacer: 'Hacer una visita al local y evaluar operación completa.', tiempo_para_implementar: 'Este mes', costo_aproximado: 'Tiempo del dueño', resultado_esperado: 'Plan de mejora en 30 días.' },
      ],
      que_medir: 'Ventas de ese local comparadas con la semana anterior.',
      urgencia: 'esta_semana',
    })),
    glosario_del_dia: [
      { termino: 'Ticket promedio', significado_simple: 'Cuánto gasta en promedio cada cliente cada vez que compra', ejemplo_concreto: 'Si vendiste $50.000 y atendiste 25 clientes, tu ticket promedio fue $2.000.' },
      { termino: 'Caída de ventas', significado_simple: 'Cuando vendés menos que el mes o semana anterior', ejemplo_concreto: 'Si Carlos Paz vendió $200.000 en mayo y $140.000 en junio, cayó un 30%.' },
    ],
    pregunta_del_dia: '¿Cuándo fue la última vez que visitaste personalmente cada uno de tus locales?',
    numero_del_dia: { numero: alertas.length.toString(), que_significa: 'situaciones que el sistema marcó como importantes', es_bueno_o_malo: alertas.length > 5 ? 'malo' : 'neutro', que_hacer_con_el: 'Revisarlas una por una y priorizar las marcadas como urgentes.' },
    proximos_pasos: ['Revisar las alertas críticas en la pestaña Analista de Ventas.', 'Aprobar o descartar las campañas de WhatsApp propuestas.', 'Publicar al menos un post de Instagram de los que generó el sistema.'],
  };
}

module.exports = { ejecutar };
