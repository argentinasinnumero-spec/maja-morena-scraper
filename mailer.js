'use strict';

/**
 * Envío de reporte diario por Gmail API (OAuth2, no SMTP).
 * Funciona en Railway sin restricciones de puertos.
 */

const https = require('https');

const CLIENT_ID     = process.env.GMAIL_CLIENT_ID;
const CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GMAIL_REFRESH_TOKEN;
const GMAIL_FROM    = process.env.GMAIL_USER || 'portogelatoespa@gmail.com';
const MAIL_DESTINO  = process.env.MAIL_DESTINO || 'gonzalofsegura@gmail.com,maurozanon33@gmail.com';

const fmt = (n) => '$' + Math.round(n || 0).toLocaleString('es-AR');
const sum = (arr, k) => arr.reduce((s, l) => s + (l[k] || 0), 0);

async function getAccessToken() {
  const body = new URLSearchParams({
    client_id:     CLIENT_ID,
    client_secret: CLIENT_SECRET,
    refresh_token: REFRESH_TOKEN,
    grant_type:    'refresh_token',
  }).toString();

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'oauth2.googleapis.com',
      path:     '/token',
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        const json = JSON.parse(data);
        if (json.access_token) resolve(json.access_token);
        else reject(new Error(json.error_description || JSON.stringify(json)));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function enviarViaGmailAPI(accessToken, to, subject, htmlBody) {
  const mensaje = [
    `From: "Maja Morena 📊" <${GMAIL_FROM}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    '',
    htmlBody,
  ].join('\r\n');

  const encoded = Buffer.from(mensaje).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const body = JSON.stringify({ raw: encoded });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'gmail.googleapis.com',
      path:     '/gmail/v1/users/me/messages/send',
      method:   'POST',
      headers:  {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode === 200 || res.statusCode === 201) resolve(JSON.parse(data));
        else reject(new Error(`Gmail API ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function armarHTML(diario, mensual) {
  const localesDiario  = Array.isArray(diario.ranking_locales) ? diario.ranking_locales :
                         Array.isArray(diario.locales) ? diario.locales : Object.values(diario.locales || {});
  const rawMensual     = mensual?.locales;
  const localesMensual = Array.isArray(rawMensual) ? rawMensual : Object.values(rawMensual || {});

  const hoyMap = {};
  for (const l of localesDiario) hoyMap[l.local_id] = l;

  const mesMap = {};
  for (const l of localesMensual) mesMap[l.local_id] = { venta_mes: l.total, nombre: l.nombre, tipo: l.tipo };

  const todosIds = new Set([...Object.keys(hoyMap), ...Object.keys(mesMap)]);
  const locales = [...todosIds].map(lid => ({
    nombre:       hoyMap[lid]?.nombre || mesMap[lid]?.nombre || lid,
    tipo:         hoyMap[lid]?.tipo   || mesMap[lid]?.tipo   || 'propio',
    local_id:     lid,
    venta_real:   hoyMap[lid]?.venta_real   || 0,
    efectivo:     hoyMap[lid]?.efectivo     || 0,
    credito:      hoyMap[lid]?.credito      || 0,
    debito:       hoyMap[lid]?.debito       || 0,
    mercado_pago: hoyMap[lid]?.mercado_pago || 0,
    operaciones:  hoyMap[lid]?.operaciones  || 0,
    venta_mes:    mesMap[lid]?.venta_mes    || 0,
    fallo_hoy:    !hoyMap[lid],
  }));

  const propios     = locales.filter(l => l.tipo === 'propio').sort((a, b) => b.venta_real - a.venta_real);
  const franquicias = locales.filter(l => l.tipo === 'franquicia').sort((a, b) => b.venta_real - a.venta_real);

  const fecha      = diario.fecha_comercial || diario.fecha || 'ayer';
  const ventaTotal = diario.venta_real || 0;
  const okCount    = diario.locales_exitosos || localesDiario.length;
  const errCount   = diario.locales_con_error || 0;
  const errores    = diario.errores || [];

  const tablaHTML = (arr) => {
    const header = ['Local','Venta Hoy','Efectivo','Crédito','Débito','MercadoPago','Acum. Mes'].map((h, i) =>
      `<th style="background:#c0392b;color:#fff;padding:8px 12px;text-align:${i===0?'left':'right'};white-space:nowrap">${h}</th>`
    ).join('');
    const rows = arr.map((l, i) => {
      const bg = l.fallo_hoy ? '#fff8e1' : (i % 2 === 0 ? '#fff' : '#fdf2f2');
      const nombreCell = l.fallo_hoy
        ? `<td style="padding:8px 12px;border-bottom:1px solid #f0e0e0;color:#999">${l.nombre} ⚠️</td>`
        : `<td style="padding:8px 12px;border-bottom:1px solid #f0e0e0;font-weight:600">${l.nombre}</td>`;
      return `<tr style="background:${bg}">${nombreCell}
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0;color:${l.fallo_hoy?'#ccc':'inherit'}">${l.fallo_hoy?'—':fmt(l.venta_real)}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0">${l.fallo_hoy?'—':fmt(l.efectivo)}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0">${l.fallo_hoy?'—':fmt(l.credito)}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0">${l.fallo_hoy?'—':fmt(l.debito)}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0">${l.fallo_hoy?'—':fmt(l.mercado_pago)}</td>
        <td style="padding:8px 12px;text-align:right;border-bottom:1px solid #f0e0e0;background:#fffbeb;font-weight:700;color:#b45309">${fmt(l.venta_mes)}</td>
      </tr>`;
    });
    const tot = `<tr>
      <td style="padding:8px 12px;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">TOTAL</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">${fmt(sum(arr,'venta_real'))}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">${fmt(sum(arr,'efectivo'))}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">${fmt(sum(arr,'credito'))}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">${fmt(sum(arr,'debito'))}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fdecea;border-top:2px solid #c0392b">${fmt(sum(arr,'mercado_pago'))}</td>
      <td style="padding:8px 12px;text-align:right;font-weight:700;background:#fef3c7;border-top:2px solid #c0392b;color:#b45309">${fmt(sum(arr,'venta_mes'))}</td>
    </tr>`;
    return `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>${header}</tr></thead><tbody>${rows.join('')}${tot}</tbody></table>`;
  };

  const rankingHTML = [...locales].sort((a, b) => b.venta_real - a.venta_real).map((l, i) => {
    const medal = i===0?'🥇':i===1?'🥈':i===2?'🥉':`${i+1}.`;
    const max = locales[0]?.venta_real || 1;
    const pct = Math.round((l.venta_real / max) * 100);
    return `<tr>
      <td style="padding:6px 12px;font-weight:600;color:${l.fallo_hoy?'#999':'inherit'}">${medal} ${l.nombre}${l.fallo_hoy?' ⚠️':''}</td>
      <td style="padding:6px 12px;text-align:right;font-weight:700">${l.fallo_hoy?'—':fmt(l.venta_real)}</td>
      <td style="padding:6px 12px;width:120px"><div style="background:#f0e0e0;border-radius:4px;height:8px"><div style="background:#c0392b;border-radius:4px;height:8px;width:${pct}%"></div></div></td>
      <td style="padding:6px 12px;text-align:right;color:#b45309;font-weight:600">${fmt(l.venta_mes)}</td>
    </tr>`;
  }).join('');

  const seccion = (emoji, titulo, arr) => `
    <h2 style="margin:24px 0 8px;color:#c0392b;font-size:15px">${emoji} ${titulo}
      <span style="color:#666;font-weight:normal"> Hoy: ${fmt(sum(arr,'venta_real'))}</span>
      <span style="color:#b45309;font-weight:600"> | Mes: ${fmt(sum(arr,'venta_mes'))}</span>
    </h2>${tablaHTML(arr)}`;

  const bannerErrores = errCount > 0 ? `
    <div style="background:#fff3cd;border:1px solid #ffc107;border-radius:6px;padding:12px 16px;margin-bottom:16px">
      ⚠️ <strong>${errCount} local${errCount>1?'es':''} no pudo conectarse hoy:</strong>
      ${errores.map(e => `<span style="background:#ffc107;color:#000;border-radius:4px;padding:2px 8px;margin:0 4px;font-size:12px">${e.usuario || e}</span>`).join('')}
      <br><small style="color:#856404">El sistema reintentará automáticamente mañana.</small>
    </div>` : '';

  return `<div style="max-width:800px;margin:0 auto;font-family:Arial,sans-serif">
    <div style="background:#c0392b;color:#fff;padding:16px 20px;border-radius:8px 8px 0 0">
      <h1 style="margin:0;font-size:18px">📊 Reporte Diario — ${fecha}</h1>
      <p style="margin:4px 0 0;font-size:14px;opacity:.9">💰 Venta Real Total: <strong>${fmt(ventaTotal)}</strong> · ${okCount} locales OK${errCount>0?' · ⚠️ '+errCount+' sin datos':''}</p>
    </div>
    <div style="background:#fff;padding:16px 20px;border:1px solid #f0e0e0;border-top:none;border-radius:0 0 8px 8px">
      ${bannerErrores}
      <h2 style="margin:0 0 8px;color:#1a1a2e;font-size:15px">🏆 Ranking del día</h2>
      <table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr>
        <th style="background:#1a1a2e;color:#fff;padding:8px 12px;text-align:left">Local</th>
        <th style="background:#1a1a2e;color:#fff;padding:8px 12px;text-align:right">Venta Hoy</th>
        <th style="background:#1a1a2e;color:#fff;padding:8px 12px"></th>
        <th style="background:#1a1a2e;color:#fff;padding:8px 12px;text-align:right">Acum. Mes</th>
      </tr></thead><tbody>${rankingHTML}</tbody></table>
      ${seccion('🏪','PROPIOS',propios)}
      ${seccion('🤝','FRANQUICIAS',franquicias)}
      <p style="margin-top:24px;font-size:11px;color:#999;text-align:center">Maja Morena — Sistema Autónomo${errCount>0?' · ⚠️ Locales con ⚠️ no pudieron conectarse hoy':''}</p>
    </div>
  </div>`;
}

async function enviarReporte(diario, mensual) {
  if (!CLIENT_ID || !CLIENT_SECRET || !REFRESH_TOKEN) {
    console.warn('[Mailer] Sin credenciales OAuth2 Gmail. Mail no enviado.');
    return false;
  }

  const accessToken = await getAccessToken();
  const fecha  = diario.fecha_comercial || diario.fecha || new Date().toLocaleDateString('es-AR');
  const html   = armarHTML(diario, mensual);
  const result = await enviarViaGmailAPI(accessToken, MAIL_DESTINO, `Reporte Diario Maja Morena — ${fecha}`, html);
  console.log(`[Mailer] ✅ Mail enviado. ID: ${result.id}`);
  return true;
}

module.exports = { enviarReporte };
