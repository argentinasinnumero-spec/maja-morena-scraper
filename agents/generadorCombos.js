'use strict';
const llm     = require('../tools/llm');
const config  = require('../config');
const calc    = require('../tools/calculos');
const reader  = require('../tools/firestoreReader');
const writer  = require('../tools/firestoreWriter');

const SYSTEM_PROMPT = `Sos el especialista en optimización de ticket promedio de Maja Morena, una cadena de empanaderías argentina.

Tu misión: diseñar combos estratégicos que suban el ticket promedio sin sacrificar margen.

El ticket promedio actual lo tenés en los datos. Querés subir ese número.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "combos": [
    {
      "nombre": "nombre comercial del combo (atractivo, corto)",
      "tipo": "ticket_alto|horario_especial|ocasion|adicion_inteligente|familiar",
      "productos": ["lista de productos incluidos"],
      "precio_referencia": número en pesos (precio justo que suba el ticket),
      "justificacion": "por qué este combo sube el ticket y tiene sentido para el cliente",
      "horario_sugerido": "ej: almuerzo 12-14hs, o null",
      "canal_sugerido": "delivery|mostrador|ambos",
      "mensaje_venta": "frase corta para el vendedor o para WhatsApp (máx 2 oraciones)",
      "incremento_ticket_estimado_pct": número (% que subiría el ticket),
      "prioridad": número del 1 al 10
    }
  ],
  "oportunidad_adicion": {
    "producto_base": "el producto que más se vende solo",
    "adicion_sugerida": "qué agregar para subir el ticket",
    "frase_vendedor": "qué decirle al cliente en el mostrador (natural, no robótica)"
  },
  "benchmark_ticket": {
    "observacion": "cómo está el ticket de Maja Morena vs una empanadería típica",
    "potencial_mejora": "cuánto podría subir el ticket con los combos sugeridos"
  },
  "resumen": "2 oraciones sobre cómo subir el ticket promedio en Maja Morena ahora mismo"
}

Importante:
- Los combos deben ser creíbles para una empanadería argentina.
- Priorizá combos que no requieran descuentos agresivos — subir ticket con valor percibido.
- Pensá en "¿qué pide alguien que va a Maja Morena y podría pedir más?"
- Los combos de delivery son diferentes a los de mostrador.`;

async function ejecutar(cicloId) {
  console.log('[GeneradorCombos] Iniciando análisis...');

  const ventas  = await reader.getUltimosNMeses(3);
  const precios = await reader.getPrecios();
  if (!ventas.length) {
    console.warn('[GeneradorCombos] Sin datos.');
    return { combos: [], resumen: 'Sin datos.' };
  }

  const ventasMes = _mesActual(ventas);
  const mix       = calc.analizarMixProductos(ventasMes);
  const ranking   = calc.rankearLocales(ventasMes);

  // Ticket promedio general y por zona
  const totalV = ranking.reduce((s, l) => s + l.ventas, 0);
  const totalT = ranking.reduce((s, l) => s + l.transacciones, 0);
  const ticketGeneral = totalT > 0 ? Math.round(totalV / totalT) : 0;

  // Ticket por zona
  const ticketPorZona = _calcularTicketPorZona(ventasMes, ranking);

  // Canales de venta
  const canalesData = _calcularCanales(ventasMes);

  // Top productos (para combinar)
  const topProductos = mix.filter(p => p.unidades > 0).slice(0, 8);
  const productosComplementarios = {
    empanadas: ['gaseosas', 'cervezas', 'aguas', 'jugos'],
    pizzas:    ['cervezas', 'gaseosas', 'vinos'],
    caseritas: ['cafe', 'jugos', 'gaseosas'],
    hamburguesas: ['gaseosas', 'cervezas', 'papas'],
  };

  // Mapa de precios
  const mapaPrecios = {};
  for (const p of precios) {
    const key = String(p.producto || '').toLowerCase().replace(/\s+/g, '_');
    mapaPrecios[key] = Number(p.precio) || 0;
  }

  const contexto = {
    fecha_analisis: new Date().toLocaleDateString('es-AR'),
    mes_analizado:  _labelMes(ventasMes),

    ticket_promedio_actual: {
      general:  calc.formatPesos(ticketGeneral),
      por_zona: ticketPorZona,
    },

    locales_ticket_bajo: ranking
      .filter(l => l.ticket > 0 && l.ticket < ticketGeneral * 0.8)
      .map(l => ({ nombre: l.nombre, zona: l.zona, ticket: calc.formatPesos(l.ticket) })),

    mix_productos: topProductos.map(p => ({
      nombre:     p.nombre,
      emoji:      p.emoji,
      categoria:  p.categoria,
      unidades:   p.unidades,
      porcentaje: p.porcentaje + '%',
    })),

    combinaciones_naturales: productosComplementarios,

    canales: canalesData,

    precios_referencia: mapaPrecios,

    benchmark: {
      ticket_bajo_esperado: 'menos de $2000',
      ticket_bueno_esperado: '$2500 a $4000',
      ticket_excelente: 'más de $4000',
    },

    contexto_negocio: {
      tipo: 'empanadería argentina',
      horarios_clave: ['desayuno 8-10hs', 'almuerzo 12-14hs', 'merienda 16-18hs', 'cena 20-23hs'],
      producto_estrella: 'empanadas (venta por docena y media docena)',
    },
  };

  let resultado;

  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `DATOS PARA ANALIZAR:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'flash',
      temperature: 0.5,
    });
  } catch (e) {
    console.error('[GeneradorCombos] Error LLM:', e.message);
    resultado = {
      combos: [{
        nombre:       'Combo Empanadas + Bebida',
        tipo:         'ticket_alto',
        productos:    ['empanadas', 'gaseosas'],
        precio_referencia: ticketGeneral * 1.3,
        justificacion: 'Combinación clásica que agrega valor sin descuento.',
        horario_sugerido: null,
        canal_sugerido: 'ambos',
        mensaje_venta: '¿Le agregamos una bebida a las empanadas? Con el combo sale más conveniente.',
        incremento_ticket_estimado_pct: 20,
        prioridad: 7,
      }],
      resumen: `Ticket promedio actual: ${calc.formatPesos(ticketGeneral)}. Hay oportunidad de incremento con combos estratégicos.`,
    };
  }

  // Guardar como oportunidades de alto impacto
  for (const combo of (resultado.combos || [])) {
    if (combo.prioridad >= 7) {
      await writer.saveOportunidad({
        tipo:            'combo',
        agente_origen:   'generador_combos',
        prioridad:       combo.prioridad,
        local:           combo.canal_sugerido === 'delivery' ? 'Canal Delivery' : 'Red completa',
        titulo:          combo.nombre,
        descripcion:     combo.justificacion,
        accion:          combo.mensaje_venta,
        impacto_estimado: `+${combo.incremento_ticket_estimado_pct}% ticket promedio`,
        revenue_potencial: 0,
        datos_soporte:   combo,
      }, cicloId);
    }
  }

  console.log(`[GeneradorCombos] ✅ ${resultado.combos?.length || 0} combos generados`);
  return resultado;
}

function _calcularTicketPorZona(ventasArr, ranking) {
  const zonas = {};
  for (const local of ranking) {
    const z = local.zona;
    if (!zonas[z]) zonas[z] = { ventas: 0, transacciones: 0 };
    zonas[z].ventas        += local.ventas;
    zonas[z].transacciones += local.transacciones;
  }
  const res = {};
  for (const [z, d] of Object.entries(zonas)) {
    res[z] = d.transacciones > 0
      ? calc.formatPesos(Math.round(d.ventas / d.transacciones))
      : 'sin datos';
  }
  return res;
}

function _calcularCanales(ventasArr) {
  const t = { mostrador: 0, delivery: 0, mesas: 0 };
  for (const v of ventasArr) {
    t.mostrador += Number(v.mostrador) || 0;
    t.delivery  += Number(v.delivery)  || 0;
    t.mesas     += Number(v.mesas)     || 0;
  }
  const total = t.mostrador + t.delivery + t.mesas;
  return {
    mostrador_pct: calc.pct(t.mostrador, total) + '%',
    delivery_pct:  calc.pct(t.delivery,  total) + '%',
    mesas_pct:     calc.pct(t.mesas,     total) + '%',
  };
}

function _mesActual(ventas) {
  const hoy = new Date();
  const res = ventas.filter(v => v.mes === hoy.getMonth() + 1 && v.ano === hoy.getFullYear());
  if (res.length) return res;
  const meses = [...new Set(ventas.map(v => `${v.ano}-${String(v.mes).padStart(2,'0')}`))].sort();
  const ultimo = meses[meses.length - 1];
  if (!ultimo) return [];
  const [a, m] = ultimo.split('-').map(Number);
  return ventas.filter(v => v.mes === m && v.ano === a);
}

function _labelMes(arr) {
  if (!arr.length) return 'sin datos';
  return `${config.meses[arr[0].mes]} ${arr[0].ano}`;
}

module.exports = { ejecutar };
