'use strict';
require('dotenv').config();

const { randomUUID }    = require('crypto');
const writer            = require('./tools/firestoreWriter');
const reader            = require('./tools/firestoreReader');
const nucleoConector    = require('./tools/nucleoConector');
const analistaVentas    = require('./agents/analistaVentas');
const recuperadorClientes = require('./agents/recuperadorClientes');
const generadorPromociones = require('./agents/generadorPromociones');
const generadorCombos        = require('./agents/generadorCombos');
const inteligenciaComercial  = require('./agents/inteligenciaComercial');
const creadorContenido       = require('./agents/creadorContenido');
const asistentePersonal      = require('./agents/asistentePersonal');
const fidelizacion           = require('./agents/fidelizacion');
const director               = require('./director');

// ─── Validate env ────────────────────────────────────────────────────────────
function validarEnv() {
  const req = ['OPENAI_API_KEY', 'FIREBASE_PROJECT_ID', 'FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY'];
  const faltantes = req.filter(k => !process.env[k]);
  if (faltantes.length) {
    console.error('❌ Variables de entorno faltantes:', faltantes.join(', '));
    console.error('   Copiá agente/.env.example a agente/.env y completá los valores.');
    process.exit(1);
  }
}

// ─── Ciclo principal ─────────────────────────────────────────────────────────
async function ejecutarCiclo(soloAgente = null) {
  validarEnv();

  const cicloId   = randomUUID().split('-')[0];
  const inicio    = new Date();
  const horaLabel = inicio.toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit' });

  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║    DIRECTOR COMERCIAL — MAJA MORENA                  ║');
  console.log(`║    Ciclo: ${cicloId}  |  ${inicio.toLocaleDateString('es-AR')} ${horaLabel}        ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  await writer.updateEstadoAgente({
    ciclo_actual:       'corriendo',
    ultimo_ciclo_id:    cicloId,
    ultimo_ciclo_inicio: inicio,
    agentes_activos:    soloAgente ? [soloAgente] : ['nucleo', 'analista', 'recuperador', 'promociones', 'combos', 'director'],
  });

  // Marcar trigger como procesado si existe
  try {
    const trigger = await reader.getPendingTrigger();
    if (trigger) {
      await writer.markTriggerDone(trigger.id);
      console.log(`[Sistema] Trigger manual procesado: ${trigger.id}`);
    }
  } catch { /* no crítico */ }

  const outputs = {};

  // ─── PASO 0: Descarga automática de ventas desde Núcleo IT ─────────────────
  // Esto corre SIEMPRE al inicio del ciclo para tener datos frescos
  // Si no hay credenciales o falla, NO corta el ciclo — avisa y sigue
  if (!soloAgente || soloAgente === 'nucleo') {
    console.log('\n─── Paso 0: Descarga de ventas — Sistema Núcleo IT ───');
    try {
      const conexion = await nucleoConector.verificarConexion();
      if (!conexion.configurado) {
        console.warn('[Núcleo] ⚠️  Sin credenciales. Configurar en MENTE MAESTRA → Configuración.');
        console.warn('[Núcleo]    Continuando ciclo con datos existentes en Firebase.');
      } else {
        const resultadoNucleo = await nucleoConector.ejecutarDescargaDiaria();
        if (resultadoNucleo.exito !== false) {
          outputs.nucleo = resultadoNucleo;
          console.log(`[Núcleo] ✅ Ventas del día ${resultadoNucleo.fecha_comercial}: $${(resultadoNucleo.venta_real || 0).toLocaleString('es-AR')} (real)`);
        } else {
          console.warn('[Núcleo] ⚠️ ', resultadoNucleo.error || 'Fallo sin detalle');
          console.warn('[Núcleo]    Continuando ciclo con datos existentes en Firebase.');
        }
      }
    } catch (eNucleo) {
      console.warn('[Núcleo] ⚠️  Error en descarga:', eNucleo.message);
      console.warn('[Núcleo]    Continuando ciclo con datos existentes en Firebase.');
    }
  }

  try {
    if (!soloAgente || soloAgente === 'analista') {
      console.log('\n─── Agente 1/4: Analista de Ventas ───────────────────');
      outputs.analista = await analistaVentas.ejecutar(cicloId).catch(e => {
        console.error('[AnalistaVentas] Falló:', e.message);
        return { alertas: [], oportunidades: [], insights: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'recuperador') {
      console.log('\n─── Agente 2/4: Recuperador de Clientes ──────────────');
      outputs.recuperador = await recuperadorClientes.ejecutar(cicloId).catch(e => {
        console.error('[RecuperadorClientes] Falló:', e.message);
        return { locales_en_riesgo: [], campañas_recuperacion: [], acciones_inmediatas: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'promociones') {
      console.log('\n─── Agente 3/4: Generador de Promociones ─────────────');
      outputs.promociones = await generadorPromociones.ejecutar(cicloId).catch(e => {
        console.error('[GeneradorPromociones] Falló:', e.message);
        return { promociones: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'combos') {
      console.log('\n─── Agente 4/5: Generador de Combos ──────────────────');
      outputs.combos = await generadorCombos.ejecutar(cicloId).catch(e => {
        console.error('[GeneradorCombos] Falló:', e.message);
        return { combos: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'inteligencia') {
      console.log('\n─── Agente 5/6: Inteligencia Comercial (Web) ─────────');
      outputs.inteligencia = await inteligenciaComercial.ejecutar(cicloId).catch(e => {
        console.error('[InteligenciaComercial] Falló:', e.message);
        return { competidores: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'contenido') {
      console.log('\n─── Agente 6/6: Creador de Contenido (Redes) ─────────');
      outputs.contenido = await creadorContenido.ejecutar(cicloId).catch(e => {
        console.error('[CreadorContenido] Falló:', e.message);
        return { posts_instagram: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'fidelizacion') {
      console.log('\n─── Agente de Fidelización y Club de Beneficios ──────');
      outputs.fidelizacion = await fidelizacion.ejecutar(cicloId).catch(e => {
        console.error('[Fidelización] Falló:', e.message);
        return { campañas_inmediatas: [], resumen: 'Error en ejecución.' };
      });
    }

    if (!soloAgente || soloAgente === 'asistente') {
      console.log('\n─── Asistente Personal: Traduciendo para el dueño ────');
      outputs.asistente = await asistentePersonal.ejecutar(cicloId).catch(e => {
        console.error('[AsistentePersonal] Falló:', e.message);
        return { diagnosticos: [], resumen_para_humanos: 'Error en ejecución.' };
      });
    }

    // Director solo si corremos el ciclo completo o explícitamente
    if (!soloAgente || soloAgente === 'director') {
      console.log('\n─── Director Comercial: Sintetizando ─────────────────');
      outputs.director = await director.ejecutar(cicloId, outputs).catch(e => {
        console.error('[Director] Falló:', e.message);
        return { decision_principal: 'Error en síntesis.', resumen_ejecutivo: '' };
      });
    }

  } catch (e) {
    console.error('[Sistema] Error inesperado:', e);
  }

  // ─── Registrar ciclo ────────────────────────────────────────────────────
  const fin    = new Date();
  const durMs  = fin - inicio;

  const contarAlertas = (o) => (o?.alertas?.length || 0) + (o?.locales_en_riesgo?.length || 0);
  const contarOps     = (o) => o?.oportunidades?.length || 0;
  const contarCampas  = (o) => (o?.campañas_recuperacion?.length || 0) + (o?.promociones?.length || 0);

  const cicloData = {
    id:                         cicloId,
    inicio,
    fin,
    duracion_ms:                durMs,
    estado:                     'completado',
    alertas_generadas:          contarAlertas(outputs.analista) + contarAlertas(outputs.recuperador),
    oportunidades_detectadas:   contarOps(outputs.analista) + contarOps(outputs.recuperador),
    campañas_propuestas:        contarCampas(outputs.recuperador) + contarCampas(outputs.promociones),
    decision_principal:         outputs.director?.decision_principal || '',
    resumen_director:           outputs.director?.resumen_ejecutivo  || '',
    mensaje_al_equipo:          outputs.director?.mensaje_al_equipo  || '',
    agentes_output: {
      analista:    _resumir(outputs.analista),
      recuperador: _resumir(outputs.recuperador),
      promociones: _resumir(outputs.promociones),
      combos:      _resumir(outputs.combos),
    },
  };

  await writer.saveCiclo(cicloId, cicloData);

  // Limpieza periódica
  await writer.limpiarAlertas(30).catch(() => {});

  // ─── Resumen en consola ────────────────────────────────────────────────
  console.log('\n');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║    CICLO COMPLETADO                                  ║');
  console.log(`║    Duración: ${(durMs / 1000).toFixed(1)}s                                    ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║    Alertas generadas:     ${cicloData.alertas_generadas}                          ║`);
  console.log(`║    Oportunidades:         ${cicloData.oportunidades_detectadas}                          ║`);
  console.log(`║    Campañas propuestas:   ${cicloData.campañas_propuestas}                          ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  if (outputs.director?.decision_principal) {
    const d = outputs.director.decision_principal.substring(0, 48);
    console.log(`║    DECISIÓN: ${d}...   ║`);
  }
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');

  return cicloData;
}

function _resumir(output) {
  if (!output) return {};
  // Solo guardar resumen para no inflar Firestore
  return {
    resumen: output.resumen || '',
    conteo:  Object.entries(output)
      .filter(([, v]) => Array.isArray(v))
      .reduce((acc, [k, v]) => { acc[k] = v.length; return acc; }, {}),
  };
}

// ─── Entry point ──────────────────────────────────────────────────────────────
const args      = process.argv.slice(2);
const soloArg   = args.find(a => a.startsWith('--solo='));
const soloAgente = soloArg ? soloArg.split('=')[1] : null;

ejecutarCiclo(soloAgente)
  .then(() => process.exit(0))
  .catch(e => {
    console.error('Error fatal:', e);
    process.exit(1);
  });
