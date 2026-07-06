'use strict';
const llm     = require('../tools/llm');
const config  = require('../config');
const calc    = require('../tools/calculos');
const reader  = require('../tools/firestoreReader');
const writer  = require('../tools/firestoreWriter');

const SYSTEM_PROMPT = `Sos el especialista en promociones de Maja Morena, una cadena de empanaderías argentina.

Tu misión: crear promociones concretas, rentables y ejecutables para aumentar ventas en productos lentos, horarios muertos y locales que necesitan impulso.

Generá una respuesta JSON con esta estructura EXACTA:

{
  "promociones": [
    {
      "nombre": "nombre comercial de la promo (corto, atractivo)",
      "tipo": "happy_hour|2x1_estrategico|producto_rescate|dia_especial|combo_express",
      "target": "a qué local, zona o canal apunta",
      "producto_estrella": "el producto que se destaca en la promo",
      "oferta": {
        "descripcion": "descripción clara de la oferta",
        "descuento_pct": número o null,
        "bonus": "descripción del bonus o null"
      },
      "horario_sugerido": "ej: 14-17hs o null si es todo el día",
      "duracion_dias": número,
      "justificacion": "por qué esta promo tiene sentido basada en los datos",
      "mensaje_whatsapp": "texto completo listo para WhatsApp con emojis",
      "costo_estimado": número en pesos o 0,
      "revenue_esperado": número en pesos,
      "prioridad": número del 1 al 10
    }
  ],
  "producto_mas_desaprovechado": {
    "nombre": "nombre del producto",
    "razon": "por qué está desaprovechado",
    "accion_inmediata": "qué hacer hoy"
  },
  "insight_canal": "observación sobre delivery/mostrador/mesas que revele oportunidad",
  "resumen": "2 oraciones sobre oportunidades promocionales actuales"
}

Importante:
- Las promos deben ser ejecutables mañana mismo.
- Los mensajes de WhatsApp deben ser cálidos, directos y con sentido de urgencia sano.
- El estilo de Maja Morena es familiar, argentino, sin pretensiones.
- Priorizá siempre rentabilidad sobre volumen puro.`;

async function ejecutar(cicloId) {
  console.log('[GeneradorPromociones] Iniciando análisis...');

  const ventas  = await reader.getUltimosNMeses(3);
  const precios = await reader.getPrecios();
  if (!ventas.length) {
    console.warn('[GeneradorPromociones] Sin datos.');
    return { promociones: [], resumen: 'Sin datos.' };
  }

  const ventasMes = _mesActual(ventas);
  const mix       = calc.analizarMixProductos(ventasMes);
  const ranking   = calc.rankearLocales(ventasMes);

  // Desglose canales
  const canales = _calcularCanales(ventasMes);

  // Productos con baja rotación (menos del 3% del total)
  const productosLentos = mix.filter(p => p.porcentaje < 3 && p.porcentaje > 0);
  const productosSinVenta = mix.filter(p => p.unidades === 0);

  // Locales con bajo delivery (oportunidad)
  const localesDeliveryBajo = ranking.filter(l => {
    const ventasL = ventasMes.filter(v => v.dependenciaId === l.id || v.dependencia === l.id);
    const deliveryTotal = ventasL.reduce((s, v) => s + (Number(v.delivery) || 0), 0);
    const mostradorTotal = ventasL.reduce((s, v) => s + (Number(v.mostrador) || 0), 0);
    const total = deliveryTotal + mostradorTotal;
    return total > 0 && deliveryTotal / total < 0.15;
  }).slice(0, 3);

  // Precio promedio de empanadas (producto estrella)
  const precioEmpanada = precios.find(p =>
    String(p.producto || '').toLowerCase().includes('empanada')
  );

  const contexto = {
    fecha_analisis: new Date().toLocaleDateString('es-AR'),
    mes_analizado:  _labelMes(ventasMes),
    total_locales:  ranking.length,

    productos_lentos: productosLentos.map(p => ({
      nombre:     p.nombre,
      emoji:      p.emoji,
      unidades:   p.unidades,
      porcentaje: p.porcentaje + '%',
    })),

    productos_sin_venta: productosSinVenta.map(p => p.nombre),

    mix_productos_completo: mix.map(p => ({
      nombre:     p.nombre,
      unidades:   p.unidades,
      porcentaje: p.porcentaje + '%',
      categoria:  p.categoria,
    })),

    canales_de_venta: canales,

    locales_delivery_bajo: localesDeliveryBajo.map(l => ({
      nombre:        l.nombre,
      zona:          l.zona,
      ventas:        calc.formatPesos(l.ventas),
      transacciones: l.transacciones,
    })),

    ranking_locales: ranking.slice(0, 8).map(l => ({
      nombre:        l.nombre,
      zona:          l.zona,
      ventas:        calc.formatPesos(l.ventas),
      ticket:        calc.formatPesos(l.ticket),
    })),

    precio_referencia_empanada: precioEmpanada
      ? `${precioEmpanada.producto}: $${precioEmpanada.precio}`
      : 'no disponible',

    contexto_negocio: {
      marca:    'Maja Morena',
      rubro:    'Empanaderías',
      productos_estrella: ['empanadas', 'pizzas', 'caseritas'],
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
    console.error('[GeneradorPromociones] Error LLM:', e.message);
    resultado = {
      promociones: productosLentos.slice(0, 2).map(p => ({
        nombre:          `Promo ${p.nombre}`,
        tipo:            'producto_rescate',
        target:          'Red completa',
        producto_estrella: p.nombre,
        oferta:          { descripcion: `Descuento especial en ${p.nombre}`, descuento_pct: 15, bonus: null },
        horario_sugerido: null,
        duracion_dias:   7,
        justificacion:   `${p.nombre} representa solo ${p.porcentaje}% de las ventas.`,
        mensaje_whatsapp: `¡Probaste nuestras ${p.nombre}? Esta semana tenés 15% OFF 🎉`,
        costo_estimado:  0,
        revenue_esperado: 0,
        prioridad:       6,
      })),
      resumen: `${productosLentos.length} productos con baja rotación detectados.`,
    };
  }

  for (const promo of (resultado.promociones || [])) {
    await writer.saveCampaña({
      nombre:          promo.nombre,
      tipo:            promo.tipo,
      agente_creador:  'generador_promociones',
      descripcion:     promo.justificacion,
      oferta:          promo.oferta,
      segmento:        promo.target,
      mensaje_whatsapp: promo.mensaje_whatsapp,
      duracion_dias:   promo.duracion_dias,
      revenue_esperado: promo.revenue_esperado || 0,
    }, cicloId);

    if (promo.prioridad >= 7) {
      await writer.saveOportunidad({
        tipo:            'promocion',
        agente_origen:   'generador_promociones',
        prioridad:       promo.prioridad,
        local:           promo.target,
        titulo:          promo.nombre,
        descripcion:     promo.justificacion,
        accion:          promo.oferta?.descripcion || '',
        impacto_estimado: calc.formatPesos(promo.revenue_esperado || 0),
        revenue_potencial: promo.revenue_esperado || 0,
      }, cicloId);
    }
  }

  console.log(`[GeneradorPromociones] ✅ ${resultado.promociones?.length || 0} promociones generadas`);
  return resultado;
}

function _calcularCanales(ventasArr) {
  const totales = { mostrador: 0, delivery: 0, mesas: 0 };
  for (const v of ventasArr) {
    totales.mostrador += Number(v.mostrador) || 0;
    totales.delivery  += Number(v.delivery)  || 0;
    totales.mesas     += Number(v.mesas)     || 0;
  }
  const total = Object.values(totales).reduce((s, v) => s + v, 0);
  return {
    mostrador:     totales.mostrador,
    delivery:      totales.delivery,
    mesas:         totales.mesas,
    mostrador_pct: calc.pct(totales.mostrador, total) + '%',
    delivery_pct:  calc.pct(totales.delivery,  total) + '%',
    mesas_pct:     calc.pct(totales.mesas,     total) + '%',
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
