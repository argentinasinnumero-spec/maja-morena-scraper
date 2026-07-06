'use strict';
const config = require('../config');

function formatPesos(n) {
  if (!n || !Number.isFinite(n)) return '$0';
  return '$' + Math.round(n).toLocaleString('es-AR');
}

function pct(valor, total) {
  if (!total) return 0;
  return Math.round((valor / total) * 1000) / 10;
}

function calcularVariacion(actual, anterior) {
  if (!anterior || anterior === 0) return null;
  return Math.round(((actual - anterior) / Math.abs(anterior)) * 1000) / 10;
}

function getValorProducto(venta, campo) {
  const val = venta[campo] ?? venta[campo.replace('cafe', 'café')] ?? 0;
  const n = Number(val);
  return Number.isFinite(n) ? n : 0;
}

function totalTransacciones(venta) {
  const canales =
    (Number(venta.mostrador) || 0) +
    (Number(venta.delivery)   || 0) +
    (Number(venta.mesas)      || 0);
  if (canales > 0) return canales;
  return Number(venta.transacciones_pos) || 0;
}

function rankearLocales(ventasArr) {
  const mapa = new Map();
  for (const v of ventasArr) {
    const id = v.dependenciaId || v.dependencia;
    if (!id) continue;
    const e = mapa.get(id) || {
      id,
      nombre: v.dependencia || id,
      ventas: 0,
      transacciones: 0,
      productos: 0,
      zona: config.zonas[id] || 'Otras',
    };
    e.ventas        += Number(v.ventas_pesos) || 0;
    e.transacciones += totalTransacciones(v);
    e.productos     += Number(v.total_de_productos) || 0;
    mapa.set(id, e);
  }
  return Array.from(mapa.values())
    .sort((a, b) => b.ventas - a.ventas)
    .map((l, i) => ({
      ...l,
      rank: i + 1,
      ticket: l.transacciones > 0 ? Math.round(l.ventas / l.transacciones) : 0,
    }));
}

function detectarCaidas(rankingActual, rankingAnterior) {
  if (!rankingAnterior || !rankingAnterior.length) return [];
  const mapaAnt = new Map(rankingAnterior.map(l => [l.id, l]));
  const caidas = [];
  for (const local of rankingActual) {
    const ant = mapaAnt.get(local.id);
    if (!ant || ant.ventas === 0) continue;
    const variacion = calcularVariacion(local.ventas, ant.ventas);
    if (variacion === null || variacion >= -config.thresholds.caida_ventas_alerta) continue;
    caidas.push({
      id: local.id,
      nombre: local.nombre,
      ventas_actual: Math.round(local.ventas),
      ventas_anterior: Math.round(ant.ventas),
      variacion_pct: variacion,
      critico: variacion <= -config.thresholds.caida_ventas_critica,
    });
  }
  return caidas.sort((a, b) => a.variacion_pct - b.variacion_pct);
}

function analizarMixProductos(ventasArr) {
  const totales = {};
  for (const p of config.productos) totales[p.campo] = 0;
  let totalUnidades = 0;
  for (const v of ventasArr) {
    for (const p of config.productos) {
      const val = getValorProducto(v, p.campo);
      totales[p.campo] += val;
      totalUnidades    += val;
    }
  }
  return config.productos
    .map(p => ({
      campo:      p.campo,
      nombre:     p.nombre,
      emoji:      p.emoji,
      categoria:  p.categoria,
      unidades:   Math.round(totales[p.campo]),
      porcentaje: pct(totales[p.campo], totalUnidades),
    }))
    .sort((a, b) => b.unidades - a.unidades);
}

function agruparPorMes(ventasArr) {
  const mapa = new Map();
  for (const v of ventasArr) {
    const key = `${v.ano}-${String(v.mes).padStart(2, '0')}`;
    const e = mapa.get(key) || { key, mes: v.mes, ano: v.ano, label: `${config.meses[v.mes]} ${v.ano}`, ventas: 0, transacciones: 0 };
    e.ventas        += Number(v.ventas_pesos) || 0;
    e.transacciones += totalTransacciones(v);
    mapa.set(key, e);
  }
  return Array.from(mapa.values()).sort((a, b) => a.key.localeCompare(b.key));
}

function detectarTendencia(historicoMeses) {
  if (historicoMeses.length < 3) return 'insuficiente';
  const u = historicoMeses.slice(-3).map(m => m.ventas);
  if (u[2] > u[1] && u[1] > u[0]) return 'subiendo';
  if (u[2] < u[1] && u[1] < u[0]) return 'bajando';
  if (u[2] < u[0] * 0.88) return 'bajando';
  if (u[2] > u[0] * 1.12) return 'subiendo';
  return 'estable';
}

function calcularConcentracion(ranking) {
  if (!ranking.length) return { top1_pct: 0, top3_pct: 0, top1_nombre: '' };
  const total = ranking.reduce((s, l) => s + l.ventas, 0);
  if (!total) return { top1_pct: 0, top3_pct: 0, top1_nombre: '' };
  return {
    top1_pct:    pct(ranking[0].ventas, total),
    top3_pct:    pct(ranking.slice(0, 3).reduce((s, l) => s + l.ventas, 0), total),
    top1_nombre: ranking[0].nombre,
  };
}

function calcularResumenEjecutivo(ventasArr, historicoMeses) {
  const ranking   = rankearLocales(ventasArr);
  const totalV    = ranking.reduce((s, l) => s + l.ventas, 0);
  const totalT    = ranking.reduce((s, l) => s + l.transacciones, 0);
  const ticket    = totalT > 0 ? Math.round(totalV / totalT) : 0;
  const promedio  = ranking.length > 0 ? totalV / ranking.length : 0;
  const mix       = analizarMixProductos(ventasArr);
  const tendencia = detectarTendencia(historicoMeses || []);
  const concentracion = calcularConcentracion(ranking);
  const localesProblema = ranking.filter(l => l.ventas < promedio * (config.thresholds.local_bajo_promedio / 100));

  return {
    total_ventas:       Math.round(totalV),
    total_transacciones: totalT,
    ticket_promedio:    ticket,
    locales_activos:    ranking.length,
    tendencia_general:  tendencia,
    concentracion,
    mix_top5:    mix.slice(0, 5),
    mix_bottom3: mix.filter(p => p.unidades > 0).slice(-3),
    sin_ventas:  mix.filter(p => p.unidades === 0).map(p => p.nombre),
    ranking_top5: ranking.slice(0, 5).map(l => ({
      nombre: l.nombre,
      ventas: Math.round(l.ventas),
      ticket: l.ticket,
      rank:   l.rank,
      zona:   l.zona,
    })),
    locales_problema: localesProblema.map(l => ({
      nombre:      l.nombre,
      ventas:      Math.round(l.ventas),
      vs_promedio: Math.round(calcularVariacion(l.ventas, promedio)),
    })),
  };
}

module.exports = {
  formatPesos,
  calcularVariacion,
  rankearLocales,
  detectarCaidas,
  analizarMixProductos,
  agruparPorMes,
  detectarTendencia,
  calcularConcentracion,
  calcularResumenEjecutivo,
  totalTransacciones,
  pct,
};
