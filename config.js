'use strict';

module.exports = {
  openai: {
    model_director: 'gpt-4o',
    model_agentes:  'gpt-4o-mini',
    max_tokens:     2500,
    temperature:    0.3,
  },

  ciclo_intervalo_horas: 6,
  historico_meses: 6,

  thresholds: {
    caida_ventas_alerta:   20,   // % caída → alerta
    caida_ventas_critica:  35,   // % caída → crítica
    caida_trans_alerta:    15,   // % caída en transacciones
    local_bajo_promedio:   60,   // % del promedio = local con problemas
    ticket_bajo_pct:       80,   // ticket < 80% del promedio → alerta
  },

  productos: [
    { campo: 'empanadas',    nombre: 'Empanadas',    emoji: '🥟', categoria: 'principal' },
    { campo: 'pizzas',       nombre: 'Pizzas',       emoji: '🍕', categoria: 'principal' },
    { campo: 'caseritas',    nombre: 'Caseritas',    emoji: '🥧', categoria: 'principal' },
    { campo: 'pizzetin',     nombre: 'Pizzetín',     emoji: '🍕', categoria: 'principal' },
    { campo: 'tartines',     nombre: 'Tartines',     emoji: '🥐', categoria: 'principal' },
    { campo: 'hamburguesas', nombre: 'Hamburguesas', emoji: '🍔', categoria: 'principal' },
    { campo: 'gaseosas',     nombre: 'Gaseosas',     emoji: '🥤', categoria: 'bebida'   },
    { campo: 'aguas',        nombre: 'Aguas',        emoji: '💧', categoria: 'bebida'   },
    { campo: 'cervezas',     nombre: 'Cervezas',     emoji: '🍺', categoria: 'bebida'   },
    { campo: 'vinos',        nombre: 'Vinos',        emoji: '🍷', categoria: 'bebida'   },
    { campo: 'helados',      nombre: 'Helados',      emoji: '🍦', categoria: 'postre'   },
    { campo: 'cafe',         nombre: 'Café',         emoji: '☕', categoria: 'bebida'   },
    { campo: 'delicias',     nombre: 'Delicias',     emoji: '🍰', categoria: 'postre'   },
    { campo: 'jugo',         nombre: 'Jugos',        emoji: '🧃', categoria: 'bebida'   },
  ],

  canales: ['mostrador', 'delivery', 'mesas'],

  // ─── Locales de la red (fuente de verdad) ───────────────────────────────
  // Estado: activo_con_sistema | activo_sin_sistema | cerrado
  locales: [
    // ── Carlos Paz y zona serrana ─────────────────────────────────────────
    { id: 'MAJAMORENA',      nombre: 'Libertad',        ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJALOSSAUCES',   nombre: 'Sol y Río',        ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJASANMARTIN',   nombre: 'San Martín',       ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJASANMARTIN58', nombre: 'Express',          ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJASARMIENTO',   nombre: 'Sarmiento',        ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJAMORENAWO',    nombre: 'WO',               ciudad: 'Villa Carlos Paz',          estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJASANTACRUZ',   nombre: 'Santa Cruz',       ciudad: 'Villa Santa Cruz del Lago', estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJACOSQUIN',     nombre: 'Cosquín',          ciudad: 'Cosquín',                   estado: 'activo_con_sistema', tipo: 'propio' },
    { id: 'MAJAMORENATANTI', nombre: 'Tanti',            ciudad: 'Tanti',                     estado: 'activo_con_sistema', tipo: 'propio' },
    // ── Córdoba interior ──────────────────────────────────────────────────
    { id: 'MAJAALTAGRACIA',  nombre: 'Alta Gracia',      ciudad: 'Alta Gracia',               estado: 'activo_con_sistema', tipo: 'franquicia' },
    { id: 'MMMORTEROS',      nombre: 'Morteros',         ciudad: 'Morteros',                  estado: 'activo_con_sistema', tipo: 'franquicia' },
    // ── Río Cuarto ────────────────────────────────────────────────────────
    { id: 'MAJARIOCUARTO',   nombre: 'Río Cuarto',       ciudad: 'Río Cuarto',                estado: 'activo_con_sistema', tipo: 'franquicia' },
    { id: 'MAJACARCANO',     nombre: 'Carcano',          ciudad: 'Carcano',                   estado: 'activo_con_sistema', tipo: 'franquicia' },
    // ── Activos SIN sistema Núcleo (no pagan el servicio — sin datos auto) ─
    { id: 'MAJAMORENAITALIA',     nombre: 'Río Cuarto Italia', ciudad: 'Río Cuarto',      estado: 'activo_sin_sistema', tipo: 'franquicia', nota: 'Sin sistema Núcleo por falta de pago' },
    { id: 'MAJAMORENAMENDIOLAZA', nombre: 'Mendiolaza',        ciudad: 'Mendiolaza',      estado: 'activo_sin_sistema', tipo: 'franquicia', nota: 'Sin sistema Núcleo por falta de pago' },
    // ── Locales cerrados / dados de baja (no considerar en análisis) ──────
    { id: 'MAJATERMINAL',    nombre: 'Terminal',         ciudad: 'Villa Carlos Paz',          estado: 'cerrado',            tipo: 'propio',    nota: 'Dado de baja' },
    // Los siguientes no tienen usuario Núcleo pero estaban en la lista de ciudades:
    { id: 'MIRAMAR',         nombre: 'Miramar',          ciudad: 'Miramar',                   estado: 'cerrado',            tipo: 'franquicia', nota: 'Local cerrado' },
    { id: 'RIOIV_PERON',     nombre: 'Río Cuarto Perón', ciudad: 'Río Cuarto',                estado: 'cerrado',            tipo: 'franquicia', nota: 'Local cerrado' },
  ],

  // Locales activos con sistema (los 13 que el scraper puede bajar)
  get locales_activos_con_sistema() {
    return this.locales.filter(l => l.estado === 'activo_con_sistema');
  },

  // Locales activos (incluyendo los sin sistema — 15 total)
  get locales_activos() {
    return this.locales.filter(l => l.estado !== 'cerrado');
  },

  zonas: {
    alta_gracia:  'Alta Gracia',
    carcano:      'Carcano',
    cosquin:      'Cosquín',
    morteros:     'Morteros',
    santa_cruz:   'Villa Santa Cruz del Lago',
    tanti:        'Tanti',
    carlos_paz:   'Villa Carlos Paz',
    express:      'Villa Carlos Paz',
    libertad:     'Villa Carlos Paz',
    san_martin:   'Villa Carlos Paz',
    sarmiento:    'Villa Carlos Paz',
    sol_y_rio:    'Villa Carlos Paz',
    wo:           'Villa Carlos Paz',
    rio_cuarto:   'Río Cuarto',
    mendiolaza:   'Mendiolaza',
  },

  // Ciudades con locales ACTIVOS (sin Miramar ni Perón que cerraron)
  ciudades_foco: [
    'Villa Carlos Paz',
    'Villa Santa Cruz del Lago',
    'Cosquín',
    'Tanti',
    'Alta Gracia',
    'Carcano',
    'Río Cuarto',
    'Morteros',
    'Mendiolaza',   // activo pero sin sistema
  ],

  // Modelo de negocio
  modelo_negocio: {
    tipo: 'marca_con_locales_propios_y_franquicias',
    descripcion: 'Maja Morena opera con una mezcla de locales propios y franquicias. La marca es UNA SOLA con identidad unificada.',
    redes_sociales: {
      modelo: 'cuenta_unica',
      descripcion: 'Una sola cuenta de Instagram/redes para toda la marca. No hay cuentas por local ni por ciudad.',
      implicacion: 'El contenido debe representar a la marca completa, no a un local específico. Puede mencionar ciudades pero siempre en nombre de la marca unificada.',
    },
    franquicias: {
      descripcion: 'Los franquiciados siguen los lineamientos de la marca pero tienen autonomía operativa.',
      implicacion_redes: 'La casa central decide el contenido de redes. Los franquiciados no publican en la cuenta oficial.',
      implicacion_campañas: 'Las campañas de WhatsApp y promociones se coordinan centralmente pero cada local puede adaptarlas.',
    },
    locales_propios: {
      descripcion: 'Los locales propios tienen control directo de la operación.',
      implicacion: 'Las métricas de locales propios son las más controlables directamente.',
    },
  },

  colecciones: {
    ventas:          'ventas',
    ventas_diarias:  'ventas_diarias',
    dependencias:    'dependencias',
    precios:         'precios',
    productos:       'productos',
    parametros:      'parametros',
    oportunidades:   'oportunidades',
    alertas:         'alertas',
    campañas:        'campañas',
    ciclos:          'ciclos_ejecucion',
    estado:          'agente_estado',
    triggers:        'agente_triggers',
    memoria:         'agente_memoria',
  },

  meses: [
    '', 'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
    'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
  ],
};
