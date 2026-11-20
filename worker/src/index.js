/* ============================================================
 * Scribe · Cloudflare Worker
 *
 * Sirve la pagina (docs/, como asset estatico) y un intermediario de Gemini
 * para que los usuarios no necesiten su propia clave en el navegador.
 *
 *   POST /api/gemini   cabecera x-scribe-code = ACCESS_CODE (codigo de equipo)
 *                      cuerpo = { systemInstruction, contents, generationConfig }
 *                      -> respuesta de Gemini (generateContent)
 *   GET  /api/health   -> { ok, configurado } (no expone valores)
 *
 * Garantias:
 *  - El modelo lo fija el servidor (GEMINI_MODEL): el navegador no elige.
 *  - Solo se reenvian campos conocidos del cuerpo (nada de tools, cachedContent, etc.).
 *  - Tope diario de llamadas (MAX_LLAMADAS_DIA, dia de Lima) y de tamano (MAX_BYTES_PEDIDO).
 *  - NO se guarda ni se registra el contenido de las transcripciones (son reuniones
 *    de clientes). Solo se cuentan llamadas y tokens. Los console.log no incluyen
 *    texto del usuario ni de Gemini, solo estados y cifras.
 *  - Reporta tokens a Pulse (registro central de gasto) sin bloquear la respuesta.
 *
 * Configuracion:
 *   GEMINI_API_KEY  SECRETO  npx wrangler secret put GEMINI_API_KEY
 *   ACCESS_CODE     SECRETO  npx wrangler secret put ACCESS_CODE
 *   SCRIBE_USO      binding KV (wrangler.jsonc)
 *   GEMINI_MODEL, MAX_LLAMADAS_DIA, MAX_BYTES_PEDIDO, PULSE_URL   variables (wrangler.jsonc)
 *   GEMINI_BASE     variable opcional, solo para pruebas locales con un Gemini simulado
 * ============================================================ */

const GEMINI_BASE_DEFAULT = 'https://generativelanguage.googleapis.com';
const MODELO_DEFAULT = 'gemini-2.5-flash';
const TTL_CONTADOR = 3 * 24 * 3600; // los contadores diarios caducan solos
const MAX_SALIDA_TOKENS = 32768;

function json(obj, status = 200, extra = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
      ...extra,
    },
  });
}

const error = (status, mensaje, extra) => json({ error: { code: status, message: mensaje } }, status, extra);

// Dia calendario de Lima (UTC-5, sin horario de verano), formato AAAA-MM-DD.
function diaLima() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
}

function segundosHastaMedianocheLima() {
  const limaMs = Date.now() - 5 * 3600 * 1000;
  return 86400 - Math.floor((limaMs / 1000) % 86400);
}

// Comparacion en tiempo constante (compara hashes del mismo largo).
async function codigoValido(dado, esperado) {
  if (!dado || !esperado) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', enc.encode(dado)),
    crypto.subtle.digest('SHA-256', enc.encode(esperado)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}

// Deja pasar solo lo que Scribe necesita enviar a Gemini.
function limpiarCuerpo(b) {
  if (!b || typeof b !== 'object' || Array.isArray(b)) return null;
  if (!Array.isArray(b.contents) || !b.contents.length) return null;
  const out = { contents: b.contents };
  if (b.systemInstruction && typeof b.systemInstruction === 'object') out.systemInstruction = b.systemInstruction;
  const g = b.generationConfig;
  if (g && typeof g === 'object') {
    const gc = {};
    if (typeof g.responseMimeType === 'string') gc.responseMimeType = g.responseMimeType;
    if (g.responseSchema && typeof g.responseSchema === 'object') gc.responseSchema = g.responseSchema;
    if (typeof g.temperature === 'number' && g.temperature >= 0 && g.temperature <= 2) gc.temperature = g.temperature;
    if (typeof g.maxOutputTokens === 'number' && g.maxOutputTokens > 0) gc.maxOutputTokens = Math.min(Math.trunc(g.maxOutputTokens), MAX_SALIDA_TOKENS);
    out.generationConfig = gc;
  }
  return out;
}

const uso = dia => `uso:${dia}`;
const leerUso = async (env, dia) => (await env.SCRIBE_USO.get(uso(dia), 'json')) || { llamadas: 0, in: 0, out: 0 };
const guardarUso = (env, dia, v) => env.SCRIBE_USO.put(uso(dia), JSON.stringify(v), { expirationTtl: TTL_CONTADOR });

async function gemini(req, env, ctx) {
  if (req.method !== 'POST') return error(405, 'Metodo no permitido.', { allow: 'POST' });
  if (!env.GEMINI_API_KEY || !env.ACCESS_CODE || !env.SCRIBE_USO) {
    return error(503, 'El servicio de Scribe aun no esta configurado. Avisa al administrador.');
  }

  // Mismo origen: la pagina y el API viven en el mismo hostname.
  const origin = req.headers.get('origin');
  if (origin && origin !== new URL(req.url).origin) return error(403, 'Origen no permitido.');

  if (!(await codigoValido(req.headers.get('x-scribe-code') || '', String(env.ACCESS_CODE)))) {
    return error(401, 'Codigo de equipo incorrecto.');
  }

  const maxBytes = Number(env.MAX_BYTES_PEDIDO) || 2 * 1024 * 1024;
  const declarado = Number(req.headers.get('content-length'));
  if (declarado > maxBytes) return error(413, 'La transcripcion es demasiado grande (maximo 2 MB por pedido).');
  const crudo = await req.arrayBuffer();
  if (crudo.byteLength > maxBytes) return error(413, 'La transcripcion es demasiado grande (maximo 2 MB por pedido).');

  let cuerpo;
  try { cuerpo = limpiarCuerpo(JSON.parse(new TextDecoder().decode(crudo))); } catch { cuerpo = null; }
  if (!cuerpo) return error(400, 'Pedido invalido.');

  // Tope diario: se reserva la llamada antes de ir a Gemini.
  const dia = diaLima();
  const maxDia = Number(env.MAX_LLAMADAS_DIA) || 300;
  let u = await leerUso(env, dia);
  if (u.llamadas >= maxDia) {
    return error(429, `Se alcanzo el tope diario de ${maxDia} minutas del equipo. Se reinicia a medianoche (hora de Lima); mientras tanto puedes usar "Mi propia clave" en la configuracion.`,
      { 'retry-after': String(segundosHastaMedianocheLima()) });
  }
  u.llamadas += 1;
  try { await guardarUso(env, dia, u); } catch { console.log('kv: no se pudo reservar la llamada'); }

  const modelo = String(env.GEMINI_MODEL || MODELO_DEFAULT);
  const base = String(env.GEMINI_BASE || GEMINI_BASE_DEFAULT).replace(/\/+$/, '');
  let r;
  try {
    r = await fetch(`${base}/v1beta/models/${encodeURIComponent(modelo)}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': String(env.GEMINI_API_KEY) },
      body: JSON.stringify(cuerpo),
    });
  } catch {
    console.log('gemini: sin conexion');
    return error(502, 'No se pudo contactar a Gemini. Intentalo de nuevo.');
  }

  if (!r.ok) {
    console.log(`gemini: estado ${r.status}`);
    // No se reenvia el cuerpo del error de Google: solo el estado.
    if (r.status === 429) return error(429, 'Gemini esta limitando las llamadas del equipo. Espera un minuto e intentalo de nuevo.');
    if (r.status === 503) return error(503, 'Gemini esta con alta demanda ahora mismo. Espera unos segundos e intentalo de nuevo.');
    if (r.status === 401 || r.status === 403) return error(502, 'El servicio de Scribe no tiene acceso a Gemini. Avisa al administrador.');
    return error(r.status === 400 ? 400 : 502, `Error de Gemini (${r.status}). Intentalo de nuevo.`);
  }

  const texto = await r.text();
  let usage = null;
  try { usage = JSON.parse(texto).usageMetadata || null; } catch { /* se devuelve igual */ }

  if (usage) {
    // Los tokens de razonamiento (thinking) se facturan como salida.
    const entrada = Math.max(0, Math.trunc(Number(usage.promptTokenCount) || 0));
    const salida = Math.max(0, Math.trunc((Number(usage.candidatesTokenCount) || 0) + (Number(usage.thoughtsTokenCount) || 0)));
    ctx.waitUntil(registrar(env, dia, modelo, entrada, salida));
  }

  return new Response(texto, {
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

// Suma tokens al contador diario y los reporta a Pulse. Nunca lanza.
async function registrar(env, dia, modelo, entrada, salida) {
  try {
    const u = await leerUso(env, dia);
    u.in += entrada; u.out += salida;
    await guardarUso(env, dia, u);
  } catch { console.log('kv: no se pudieron sumar los tokens'); }

  if (!env.PULSE_URL) return;
  try {
    const r = await fetch(env.PULSE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: 'scribe', provider: 'google', model: modelo, inputTokens: entrada, outputTokens: salida }),
    });
    console.log(`pulse: estado ${r.status}`);
  } catch { console.log('pulse: sin conexion'); }
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === '/api/gemini') {
      try { return await gemini(req, env, ctx); }
      catch (e) { console.log('error interno'); return error(500, 'Error interno de Scribe.'); }
    }
    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        modelo: String(env.GEMINI_MODEL || MODELO_DEFAULT),
        configurado: { GEMINI_API_KEY: !!env.GEMINI_API_KEY, ACCESS_CODE: !!env.ACCESS_CODE, SCRIBE_USO: !!env.SCRIBE_USO },
      });
    }
    if (url.pathname.startsWith('/api/')) return error(404, 'No encontrado.');
    // Respaldo: normalmente la pagina la atiende el CDN sin pasar por aqui.
    return env.ASSETS.fetch(req);
  },
};
