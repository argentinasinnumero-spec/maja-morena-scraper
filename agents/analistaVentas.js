'use strict';
const llm    = require('../tools/llm');
const config = require('../config');
const calc   = require('../tools/calculos');
const reader = require('../tools/firestoreReader');
const writer = require('../tools/firestoreWriter');

const SYSTEM_PROMPT = `Sos el Analista de Ventas de Maja Morena, una cadena de empanaderías argentina con locales en Córdoba Capital, Córdoba Interior y Río Cuarto.

Tu único objetivo es detectar problemas y oportunidades en los datos de ventas.

Analizá los datos provistos y generá una respuesta JSON con esta estructura EXACTA:

{
  "alertas": [
    {
      "nivel": "critica|alta|media",
      "tipo": "caida_ventas|caida_transacciones|local_problema|producto_sin_rotacion|concentracion_riesgo",
      "local": "nombre del local o 'Red completa'",
      "titulo": "título corto y directo",
      "descripcion": "qué está pasando, con números concretos",
      "accion_sugerida": "qué hacer ahora mismo"
    }
  ],
  "oportunidades": [
    {
      "tipo": "local_desaprovechado|producto_oculto|zona_sin_campa|ticket_bajo|delivery_bajo",
      "local": "nombre del local o zona",
      "titulo": "título de la oportunidad",
      "descripcion": "por qué es una oportunidad, con datos",
      "accion": "acción concreta a tomar",
      "revenue_potencial": número en pesos,
      "prioridad": número del 1 al 10
    }
  ],
  "insights": [
    "observación importante sobre el negocio"
  ],
  "resumen": "párrafo de 2-3 oraciones con el estado general del negocio esta semana"
}

Sé específico con los números. Usá pesos argentinos. Pensá como analista con experiencia en gastronomía argentina.`;

async function ejecutar(cicloId) {
  console.log('[AnalistaVentas] Iniciando análisis...');

  const ventas       = await reader.getUltimosNMeses(config.historico_meses);
  const dependencias = await reader.getDependencias();
  const parametros   = await reader.getParametrosUltimos();
  const memoria      = await reader.getAgenteMemoria('analista_ventas');

  if (!ventas.length) {
    console.warn('[AnalistaVentas] Sin datos de ventas.');
    return { alertas: [], oportunidades: [], insights: ['Sin datos de ventas disponibles.'], resumen: 'Sin datos.' };
  }

  // --- Pre-calcular para enviar contexto rico al LLM ---
  const ventasMes      = _mesActual(ventas);
  const ventasMesAnt   = _mesAnterior(ventas);
  const historicoMeses = calc.agruparPorMes(ventas);
  const resumen        = calc.calcularResumenEjecutivo(ventasMes, historicoMeses);
  const rankingActual  = calc.rankearLocales(ventasMes);
  const rankingAnt     = calc.rankearLocales(ventasMesAnt);
  const caidas         = calc.detectarCaidas(rankingActual, rankingAnt);
  const mix            = calc.analizarMixProductos(ventasMes);
  const tendencia      = calc.detectarTendencia(historicoMeses);

  const contexto = {
    fecha_analisis: new Date().toLocaleDateString('es-AR'),
    mes_actual:     _labelMes(ventasMes),
    mes_anterior:   _labelMes(ventasMesAnt),
    inflacion_ref:  parametros?.inflacion || null,
    tendencia_general: tendencia,

    resumen_mes_actual: resumen,

    caidas_detectadas: caidas,

    ranking_completo: rankingActual.map(l => ({
      rank:        l.rank,
      nombre:      l.nombre,
      zona:        l.zona,
      ventas:      calc.formatPesos(l.ventas),
      ticket:      calc.formatPesos(l.ticket),
      transacciones: l.transacciones,
    })),

    mix_productos: mix.map(p => ({
      nombre:     p.nombre,
      emoji:      p.emoji,
      unidades:   p.unidades,
      porcentaje: p.porcentaje + '%',
    })),

    historico_ultimos_meses: historicoMeses.slice(-6).map(m => ({
      periodo:      m.label,
      ventas:       calc.formatPesos(m.ventas),
      transacciones: m.transacciones,
    })),

    aprendizajes_anteriores: memoria.aprendizajes || [],
  };

  let resultado;

  try {
    resultado = await llm.ask({
      system: SYSTEM_PROMPT,
      user:   `DATOS PARA ANALIZAR:\n${JSON.stringify(contexto, null, 2)}`,
      model:  'flash',
    });
  } catch (e) {
    console.error('[AnalistaVentas] Error LLM:', e.message);
    resultado = {
      alertas:     caidas.map(c => ({
        nivel: c.critico ? 'critica' : 'alta',
        tipo:  'caida_ventas',
        local: c.nombre,
        titulo: `Caída de ventas en ${c.nombre}`,
        descripcion: `Caída del ${Math.abs(c.variacion_pct)}% vs mes anterior.`,
        accion_sugerida: 'Revisar operación y lanzar promoción de recuperación.',
      })),
      oportunidades: resumen.locales_problema.map(l => ({
        tipo:     'local_desaprovechado',
        local:    l.nombre,
        titulo:   `${l.nombre} por debajo del promedio`,
        descripcion: `Ventas ${Math.abs(l.vs_promedio)}% por debajo del promedio de la red.`,
        accion:   'Activar campaña específica para este local.',
        revenue_potencial: 0,
        prioridad: 7,
      })),
      insights: [`Tendencia general: ${tendencia}.`],
      resumen: `Análisis del ${contexto.fecha_analisis}. Tendencia: ${tendencia}. Locales con datos: ${rankingActual.length}.`,
    };
  }

  // --- Guardar en Firestore ---
  for (const alerta of (resultado.alertas || [])) {
    await writer.saveAlerta(alerta, cicloId);
  }
  for (const op of (resultado.oportunidades || [])) {
    await writer.saveOportunidad({ ...op, agente_origen: 'analista_ventas' }, cicloId);
  }

  // Actualizar memoria
  await writer.saveAgenteMemoria('analista_ventas', {
    ultimo_ciclo:       new Date(),
    tendencia_guardada: tendencia,
    aprendizajes:       (memoria.aprendizajes || []).slice(-10),
  });

  console.log(`[AnalistaVentas] ✅ ${resultado.alertas?.length || 0} alertas, ${resultado.oportunidades?.length || 0} oportunidades`);
  return resultado;
}

// --- Helpers ---

function _mesActual(ventas) {
  const hoy = new Date();
  const mes = hoy.getMonth() + 1;
  const ano = hoy.getFullYear();
  const res = ventas.filter(v => v.mes === mes && v.ano === ano);
  if (res.length) return res;
  // Si no hay datos del mes actual, tomar el último mes disponible
  const meses = [...new Set(ventas.map(v => `${v.ano}-${String(v.mes).padStart(2,'0')}`))].sort();
  const ultimo = meses[meses.length - 1];
  if (!ultimo) return [];
  const [a, m] = ultimo.split('-').map(Number);
  return ventas.filter(v => v.mes === m && v.ano === a);
}

function _mesAnterior(ventas) {
  const actual = _mesActual(ventas);
  if (!actual.length) return [];
  const v0 = actual[0];
  let mes = v0.mes - 1;
  let ano = v0.ano;
  if (mes < 1) { mes = 12; ano--; }
  return ventas.filter(v => v.mes === mes && v.ano === ano);
}

function _labelMes(ventasArr) {
  if (!ventasArr.length) return 'sin datos';
  const v = ventasArr[0];
  return `${config.meses[v.mes]} ${v.ano}`;
}

module.exports = { ejecutar };
