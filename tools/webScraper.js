'use strict';
const axios   = require('axios');
const cheerio = require('cheerio');

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'es-AR,es;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Búsqueda DuckDuckGo (sin API key)
 */
async function buscar(query, maxResultados = 8) {
  try {
    const url = `https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`;
    const resp = await axios.get(url, { headers: HEADERS, timeout: 10000 });
    const $    = cheerio.load(resp.data);
    const resultados = [];

    $('a.result-link').each((i, el) => {
      if (i >= maxResultados) return false;
      const titulo = $(el).text().trim();
      const href   = $(el).attr('href') || '';
      resultados.push({ titulo, url: href });
    });

    // Fallback: parsear links de texto plano
    if (!resultados.length) {
      $('a[href*="http"]').each((i, el) => {
        if (i >= maxResultados) return false;
        const href = $(el).attr('href') || '';
        const texto = $(el).text().trim();
        if (href.startsWith('http') && texto.length > 5) {
          resultados.push({ titulo: texto, url: href });
        }
      });
    }

    return resultados;
  } catch (e) {
    console.warn('[WebScraper] Error en búsqueda:', e.message);
    return [];
  }
}

/**
 * Fetch simple de una URL pública y extrae texto limpio
 */
async function fetchPagina(url, maxChars = 3000) {
  try {
    const resp = await axios.get(url, {
      headers:  HEADERS,
      timeout:  12000,
      maxRedirects: 5,
    });
    const $ = cheerio.load(resp.data);

    // Remover scripts, styles, etc.
    $('script, style, nav, footer, header, iframe, noscript').remove();

    const texto = $('body').text()
      .replace(/\s+/g, ' ')
      .replace(/\n+/g, '\n')
      .trim()
      .slice(0, maxChars);

    const titulo = $('title').text().trim();
    const meta   = $('meta[name="description"]').attr('content') || '';

    return { titulo, meta, texto, url };
  } catch (e) {
    return { titulo: '', meta: '', texto: '', url, error: e.message };
  }
}

/**
 * Obtiene datos públicos de un perfil de Instagram (sin login)
 * Usa el endpoint público de oEmbed
 */
async function fetchInstagramPerfil(username) {
  try {
    // Endpoint público que no requiere auth
    const url = `https://www.instagram.com/${username}/`;
    const resp = await axios.get(url, {
      headers: {
        ...HEADERS,
        'Accept': 'text/html',
      },
      timeout: 10000,
    });

    const $ = cheerio.load(resp.data);

    // Instagram mete datos en JSON dentro de <script>
    let datos = {};
    $('script[type="application/ld+json"]').each((i, el) => {
      try {
        const json = JSON.parse($(el).html());
        datos = { ...datos, ...json };
      } catch {}
    });

    // Extraer meta tags
    const descripcion = $('meta[name="description"]').attr('content') || '';
    const ogTitle     = $('meta[property="og:title"]').attr('content') || '';
    const ogDesc      = $('meta[property="og:description"]').attr('content') || '';

    return {
      username,
      titulo:      ogTitle || datos.name || '',
      descripcion: ogDesc || descripcion,
      url:         `https://www.instagram.com/${username}/`,
    };
  } catch (e) {
    return { username, error: e.message };
  }
}

/**
 * Busca reseñas/datos de Google Maps via búsqueda web
 */
async function buscarEnGoogleMaps(nombre, ciudad) {
  const query = `${nombre} empanadas ${ciudad} google maps reseñas calificación`;
  const resultados = await buscar(query, 5);

  // También buscar directamente en la web del lugar
  const queryDirecto = `"${nombre}" "${ciudad}" empanadas calificación reseñas`;
  const resultados2  = await buscar(queryDirecto, 5);

  return [...resultados, ...resultados2].slice(0, 6);
}

/**
 * Scraping de texto de múltiples URLs en paralelo
 */
async function fetchMultiple(urls, maxChars = 2000) {
  const promises = urls.map(url => fetchPagina(url, maxChars));
  const results  = await Promise.allSettled(promises);
  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value)
    .filter(r => r.texto && r.texto.length > 100);
}

module.exports = {
  buscar,
  fetchPagina,
  fetchInstagramPerfil,
  buscarEnGoogleMaps,
  fetchMultiple,
};
