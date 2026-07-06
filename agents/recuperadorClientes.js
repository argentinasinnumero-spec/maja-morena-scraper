'use strict';
const llm     = require('../tools/llm');
const config  = require('../config');
const calc    = require('../tools/calculos');
const reader  = require('../tools/firestoreReader');
const writer  = require('../tools/firestoreWriter');

const SYSTEM_PROMPT = `Sos el especialista en recuperación de ventas de Maja Morena, una cadena de empanaderías argentina.

Analizás datos de locales que tienen caída de actividad (transacciones y ventas) y diseñás campañas de recuperación concretas y ejecutables vía WhatsApp.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "locales_en_riesgo": [
    {
      "nombre": "nombre del local",
      "zona": "Córdoba Capital|Córdoba Interior|Río Cuarto",
      "diagnostico": "qué está pasando en 1-2 oraciones",
      "urgencia": "critica|alta|media",
      "caida_ventas_pct": número,
      "caida_transacciones_pct": número
    }
  ],
  "campañas_recuperacion": [
    {
      "nombre": "nombre de la campaña",
      "tipo": "recuperacion_local|reactivacion_zona|boost_horario",
      "local_o_zona": "a quién va dirigida",
      "segmento": "descripción del segmento objetivo (ej: clientes habituales de ese local)",
      "oferta": {
        "tipo": "descuento|2x1|bonus|combo_especial",
        "valor": "descripción de la oferta (ej: 20% OFF en empanadas)",
        "productos": ["empanadas", "gaseosas"]
      },
      "mensaje_whatsapp": "texto completo listo para enviar por WhatsApp (informal, cercano, con emoji)",
      "duracion_dias": número,
      "revenue_esperado": número en pesos,
      "prioridad": número del 1 al 10
    }
  ],
  "acciones_inmediatas": [
    "acción concreta que se puede hacer hoy"
  ],
  "resumen": "estado de la recuperación de clientes en 2 oraciones"
}

Importante: los mensajes de WhatsApp deben sonar humanos, cercanos y con urgencia sin ser agresivos. Maja Morena es una marca familiar y cálida.`;

async function ejecutar(cicloId) {
  console.log('[RecuperadorClientes] Iniciando análisis...');

  const ventas = await reader.getUltimosNMeses(3);
  if (!ventas.length) {
    console.warn('[RecuperadorClientes] Sin datos.');
    return { locales_en_riesgo: [], campañas_recuperacion: [], acciones_inmediatas: [], resumen: 'Sin datos.' };
  }

  const ventasMes    = _mesActual(ventas);
  const ventasMesAnt = _mesAnterior(ventas);
  const ventasMes2   = _mesHaceN(ventas, 2);

  const rankingActual = calc.rankearLocales(ventasMes);
  const rankingAnt    = calc.rankearLocales(ventasMesAnt);
  const caidas        = calc.detectarCaidas(rankingActual, rankingAnt);

  // Caída sostenida (2 meses consecutivos bajando)
  const ranking2Meses = calc.rankearLocales(ventasMes2);
  const caidasSostenidas = calc.detectarCaidas(rankingAnt, ranking2Meses).filter(c =>
    caidas.some(c2 => c2.id === c.id)
  );

  // Locales con bajo ticket vs promedio de la red
  const ticketPromRed = rankingActual.length
    ? rankingActual.reduce((s, l) => s + l.ticket, 0) / rankingActual.length
    : 0;
  const ticketBajo = rankingActual.filter(l =>
    l.ticket > 0 && l.ticket < ticketPromRed * (config.thresholds.ticket_bajo_pct / 100)
  );

  const contexto = {
    fecha_analisis: new Date().toLocaleDateString('es-AR'),
    mes_actual:     _labelMes(ventasMes),
    mes_anterior:   _labelMes(ventasMesAnt),

    caidas_este_mes: caidas,
    caidas_sostenidas_2_meses: caidasSostenidas,

    locales_ticket_bajo: ticketBajo.map(l => ({
      nombre:         l.nombre,
      ticket:         calc.formatPesos(l.ticket),
      ticket_red:     calc.formatPesos(ticketPromRed),
      diferencia_pct: Math.round(calc.calcularVariacion(l.ticket, ticketPromRed)),
    })),

    ranking_actual: rankingActual.map(l => ({
      nombre:        l.nombre,
      zona:          l.zona,
      ventas:        calc.formatPesos(l.ventas),
      transacciones: l.transacciones,
      ticket:        calc.formatPesos(l.ticket),
    })),

    contexto_negocio: {
      marca:    'Maja Morena',
      rubro:    'Empanaderías (empanadas, pizzas y más)',
      canales:  'mostrador, delivery, mesas',
      ciudades: 'Córdoba Capital, Río Cuarto, Córdoba Interior',
    },
  };

  let resultado;

  try {
    resultado = await llm.ask({
      system:      SYSTEM_PROMPT,
      user:        `DATOS PARA ANALIZAR:\n${JSON.stringify(contexto, null, 2)}`,
      model:       'flash',
      temperature: 0.4,
    });
  } catch (e) {
    console.error('[RecuperadorClientes] Error LLM:', e.message);
    resultado = {
      locales_en_riesgo: caidas.map(c => ({
        nombre: c.nombre,
        zona:   config.zonas[c.id] || 'Otras',
        diagnostico: `Caída del ${Math.abs(c.variacion_pct)}% en ventas respecto al mes anterior.`,
        urgencia: c.critico ? 'critica' : 'alta',
        caida_ventas_pct:       Math.abs(c.variacion_pct),
        caida_transacciones_pct: 0,
      })),
      campañas_recuperacion: [],
      acciones_inmediatas: ['Revisar operación en locales con caída crítica.'],
      resumen: `${caidas.length} locales con caída de ventas detectados.`,
    };
  }

  // Guardar en Firestore
  for (const campaña of (resultado.campañas_recuperacion || [])) {
    await writer.saveCampaña(
      { ...campaña, agente_creador: 'recuperador_clientes' },
      cicloId
    );
  }
  for (const local of (resultado.locales_en_riesgo || [])) {
    if (local.urgencia === 'critica' || local.urgencia === 'alta') {
      await writer.saveAlerta({
        nivel:           local.urgencia === 'critica' ? 'critica' : 'alta',
        tipo:            'caida_transacciones',
        local:           local.nombre,
        titulo:          `${local.nombre} necesita recuperación`,
        descripcion:     local.diagnostico,
        accion_sugerida: `Activar campaña de recuperación para ${local.nombre}.`,
        datos:           local,
      }, cicloId);
    }
  }

  console.log(`[RecuperadorClientes] ✅ ${resultado.locales_en_riesgo?.length || 0} locales en riesgo, ${resultado.campañas_recuperacion?.length || 0} campañas propuestas`);
  return resultado;
}

function _mesActual(ventas) {
  const hoy  = new Date();
  const res  = ventas.filter(v => v.mes === hoy.getMonth() + 1 && v.ano === hoy.getFullYear());
  if (res.length) return res;
  const meses = [...new Set(ventas.map(v => `${v.ano}-${String(v.mes).padStart(2,'0')}`))].sort();
  const ultimo = meses[meses.length - 1];
  if (!ultimo) return [];
  const [a, m] = ultimo.split('-').map(Number);
  return ventas.filter(v => v.mes === m && v.ano === a);
}

function _mesAnterior(ventas) {
  const actual = _mesActual(ventas);
  if (!actual.length) return [];
  let mes = actual[0].mes - 1, ano = actual[0].ano;
  if (mes < 1) { mes = 12; ano--; }
  return ventas.filter(v => v.mes === mes && v.ano === ano);
}

function _mesHaceN(ventas, n) {
  const actual = _mesActual(ventas);
  if (!actual.length) return [];
  let mes = actual[0].mes - n, ano = actual[0].ano;
  while (mes < 1) { mes += 12; ano--; }
  return ventas.filter(v => v.mes === mes && v.ano === ano);
}

function _labelMes(ventasArr) {
  if (!ventasArr.length) return 'sin datos';
  const v = ventasArr[0];
  return `${config.meses[v.mes]} ${v.ano}`;
}

module.exports = { ejecutar };
