// Prueba local del intermediario de Scribe, sin gastar Gemini real ni tocar Pulse de produccion.
//
// 1) Crear worker/.dev.vars (ignorado por git) con valores FALSOS:
//      GEMINI_API_KEY=clave-falsa-de-prueba
//      ACCESS_CODE=codigo-de-prueba-local
//      GEMINI_BASE=http://127.0.0.1:8788
//      PULSE_URL=http://127.0.0.1:8788/api/ai-usage
//      MAX_LLAMADAS_DIA=3
// 2) En una terminal, desde worker/:   npx wrangler dev --port 8787
// 3) En otra, desde worker/:           node test/prueba-local.mjs
//
// Usa solo transcripciones FICTICIAS. Este script levanta un Gemini y un Pulse simulados en el puerto 8788.

import http from 'node:http';

const BASE = process.env.BASE || 'http://127.0.0.1:8787';
const CODIGO = process.env.CODIGO || 'codigo-de-prueba-local';
const MAX_DIA = Number(process.env.MAX_DIA || 3);

// ---------- Servidor simulado (Gemini + Pulse) ----------
const recibidoGemini = [];
const recibidoPulse = [];
const mock = http.createServer((req, res) => {
  let b = '';
  req.on('data', c => (b += c));
  req.on('end', () => {
    if (req.url.includes(':generateContent')) {
      recibidoGemini.push({ url: req.url, key: req.headers['x-goog-api-key'], body: JSON.parse(b) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        candidates: [{ content: { parts: [{ text: JSON.stringify({ fecha_reunion: '2026-01-05', participantes: ['Persona Ficticia A'], acuerdos: [] }) }] }, finishReason: 'STOP' }],
        usageMetadata: { promptTokenCount: 1200, candidatesTokenCount: 300, thoughtsTokenCount: 200, totalTokenCount: 1700 },
      }));
    } else if (req.url === '/api/ai-usage') {
      recibidoPulse.push(JSON.parse(b));
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    } else { res.statusCode = 404; res.end(); }
  });
});
await new Promise(r => mock.listen(8788, '127.0.0.1', r));

// ---------- Utilidades ----------
let fallos = 0;
const ok = (cond, nombre, detalle = '') => { console.log(`${cond ? 'OK   ' : 'FALLA'} ${nombre}${detalle ? '  -> ' + detalle : ''}`); if (!cond) fallos++; };
const llamar = (cuerpo, cabeceras = {}, metodo = 'POST') =>
  fetch(BASE + '/api/gemini', { method: metodo, headers: { 'content-type': 'application/json', ...cabeceras }, body: metodo === 'GET' ? undefined : (typeof cuerpo === 'string' ? cuerpo : JSON.stringify(cuerpo)) });
const pedido = (texto = 'Transcripcion FICTICIA: Persona A y Persona B revisan el proyecto Demo.') => ({
  systemInstruction: { parts: [{ text: 'Eres Scribe (prueba).' }] },
  contents: [{ role: 'user', parts: [{ text: texto }] }],
  generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
});
const esperar = ms => new Promise(r => setTimeout(r, ms));

// ---------- Casos ----------
let r = await fetch(BASE + '/api/health'); let h = await r.json();
ok(r.status === 200 && h.configurado.GEMINI_API_KEY && h.configurado.ACCESS_CODE && h.configurado.SCRIBE_USO, 'health: secretos y KV configurados', JSON.stringify(h));

r = await llamar(pedido());
ok(r.status === 401, 'sin codigo -> 401', String(r.status));
r = await llamar(pedido(), { 'x-scribe-code': 'codigo-falso' });
ok(r.status === 401, 'codigo falso -> 401', String(r.status));
r = await llamar(pedido(), { 'x-scribe-code': CODIGO, origin: 'https://sitio-ajeno.example' });
ok(r.status === 403, 'origen ajeno -> 403', String(r.status));
r = await llamar(null, { 'x-scribe-code': CODIGO }, 'GET');
ok(r.status === 405, 'GET -> 405', String(r.status));
ok(recibidoGemini.length === 0, 'ninguna de las llamadas rechazadas llego a Gemini', String(recibidoGemini.length));

r = await llamar('esto no es json', { 'x-scribe-code': CODIGO });
ok(r.status === 400, 'cuerpo no JSON -> 400', String(r.status));
r = await llamar({ contents: [] }, { 'x-scribe-code': CODIGO });
ok(r.status === 400, 'contents vacio -> 400', String(r.status));

const grande = pedido('x'.repeat(2.2 * 1024 * 1024));
r = await llamar(grande, { 'x-scribe-code': CODIGO });
ok(r.status === 413, 'pedido de ~2,2 MB -> 413', String(r.status));
ok(recibidoGemini.length === 0, 'el pedido grande tampoco llego a Gemini');

// 1) llamada buena
r = await llamar(pedido(), { 'x-scribe-code': CODIGO });
let data = await r.json();
ok(r.status === 200 && data.candidates?.[0]?.content?.parts?.[0]?.text, 'llamada valida -> 200 con respuesta de Gemini', String(r.status));
ok(recibidoGemini[0]?.key === 'clave-falsa-de-prueba', 'el Worker puso la clave de Gemini (el navegador no la manda)');
ok(recibidoGemini[0]?.url.includes('/models/gemini-2.5-flash:generateContent'), 'modelo fijo en el servidor', recibidoGemini[0]?.url);

// 2) el navegador intenta colar modelo, tools y otros campos
r = await llamar({ ...pedido(), model: 'gemini-2.5-pro', tools: [{ googleSearch: {} }], cachedContent: 'x', safetySettings: [], generationConfig: { temperature: 0.2, maxOutputTokens: 9999999, candidateCount: 8 } }, { 'x-scribe-code': CODIGO });
await r.text();
const enviado = recibidoGemini[1]?.body || {};
ok(!('tools' in enviado) && !('model' in enviado) && !('cachedContent' in enviado) && !('safetySettings' in enviado), 'campos no permitidos no se reenvian', Object.keys(enviado).join(','));
ok(enviado.generationConfig?.maxOutputTokens === 32768 && !('candidateCount' in enviado.generationConfig), 'maxOutputTokens acotado y candidateCount descartado', JSON.stringify(enviado.generationConfig));
ok(recibidoGemini[1]?.url.includes('gemini-2.5-flash') && !recibidoGemini[1].url.includes('pro'), 'el modelo pedido por el navegador se ignora');

// 3) tercera llamada (llega al tope)
r = await llamar(pedido(), { 'x-scribe-code': CODIGO }); await r.text();
await esperar(1500); // ctx.waitUntil: tokens a Pulse

ok(recibidoPulse.length === 3, 'Pulse recibio un reporte por llamada exitosa', String(recibidoPulse.length));
const p = recibidoPulse[0] || {};
ok(p.tool === 'scribe' && p.provider === 'google' && p.model === 'gemini-2.5-flash' && p.inputTokens === 1200 && p.outputTokens === 500,
  'reporte a Pulse: tool/provider/model y tokens (salida = respuesta + razonamiento)', JSON.stringify(p));
ok(!JSON.stringify(recibidoPulse).includes('FICTICIA'), 'el reporte a Pulse no contiene texto de la transcripcion');

// 4) tope diario
r = await llamar(pedido(), { 'x-scribe-code': CODIGO });
const t = await r.json().catch(() => ({}));
ok(r.status === 429 && /tope diario/.test(t.error?.message || '') && Number(r.headers.get('retry-after')) > 0, `llamada ${MAX_DIA + 1} -> 429 con mensaje claro y retry-after`, `${r.status} ${t.error?.message || ''} retry-after=${r.headers.get('retry-after')}`);
ok(recibidoGemini.length === MAX_DIA, 'la llamada bloqueada por el tope no llego a Gemini', String(recibidoGemini.length));

mock.close();
console.log(fallos ? `\n${fallos} prueba(s) fallaron` : '\nTodas las pruebas pasaron');
process.exit(fallos ? 1 : 0);
