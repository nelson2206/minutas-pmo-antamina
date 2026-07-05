const $ = id => document.getElementById(id);
const ESTADOS = ['Pendiente', 'Programado', 'En curso', 'Observado', 'Completado'];
const GEMINI_MODEL = 'gemini-2.5-flash';

// ---------- Almacenamiento local (este navegador) ----------

const LS = {
  key: () => localStorage.getItem('scribe_gemini_key') || '',
  setKey: v => localStorage.setItem('scribe_gemini_key', v),
  projects: () => JSON.parse(localStorage.getItem('scribe_projects') || '[]'),
  setProjects: p => localStorage.setItem('scribe_projects', JSON.stringify(p)),
  acuerdos: id => JSON.parse(localStorage.getItem('scribe_acuerdos_' + id) || '[]'),
  setAcuerdos: (id, a) => localStorage.setItem('scribe_acuerdos_' + id, JSON.stringify(a)),
};

let projects = [];

// ---------- Fechas (zona horaria de Lima) ----------

function hoyISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' });
}

function lunesDeLaSemana(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  const day = d.getDay();
  const diff = day === 0 ? 6 : day - 1;
  d.setDate(d.getDate() - diff);
  return d.toISOString().slice(0, 10);
}

function fechaLarga(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString('es-PE', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'America/Lima' });
}

// Completados solo si se cerraron en la semana actual
function visibleEnMinuta(a, lunesSemana) {
  if (a.estado !== 'Completado') return true;
  return Boolean(a.fecha_cierre && a.fecha_cierre >= lunesSemana);
}

// ---------- Configuración de API key ----------

function refreshKeyStatus() {
  $('keyStatus').textContent = LS.key()
    ? 'API key configurada en este navegador.'
    : 'Aún no hay API key configurada.';
}

$('btnConfig').addEventListener('click', () => {
  $('panelConfig').classList.toggle('hidden');
  $('apiKey').value = LS.key();
  refreshKeyStatus();
});

$('btnGuardarKey').addEventListener('click', () => {
  LS.setKey($('apiKey').value.trim());
  refreshKeyStatus();
  if (LS.key()) $('panelConfig').classList.add('hidden');
});

// ---------- Proyectos ----------

function cargarProyectos(selectedId) {
  projects = LS.projects();
  const sel = $('projectSelect');
  sel.innerHTML = projects.length
    ? projects.map(p => `<option value="${p.id}">${p.nombre}</option>`).join('')
    : '<option value="">— Crea un proyecto primero —</option>';
  if (selectedId) sel.value = selectedId;
  actualizarHint();
}

function proyectoActual() {
  return projects.find(p => p.id === $('projectSelect').value);
}

function actualizarHint() {
  const p = proyectoActual();
  $('stakeholdersHint').textContent = p
    ? `Destinatarios: ${p.stakeholders.length ? p.stakeholders.join(', ') : '(sin correos configurados)'}`
    : '';
}

$('projectSelect').addEventListener('change', actualizarHint);

$('btnNuevoProyecto').addEventListener('click', () => {
  const nombre = prompt('Nombre del proyecto:');
  if (!nombre) return;
  const correos = prompt('Correos de los interesados (separados por coma o punto y coma):') || '';
  const p = {
    id: Math.random().toString(36).slice(2, 10),
    nombre: nombre.trim(),
    stakeholders: correos.split(/[,;]/).map(s => s.trim()).filter(Boolean),
  };
  const all = LS.projects(); all.push(p); LS.setProjects(all);
  cargarProyectos(p.id);
});

$('btnEditarProyecto').addEventListener('click', () => {
  const p = proyectoActual();
  if (!p) return alert('Selecciona un proyecto primero.');
  const correos = prompt(`Correos de los interesados de "${p.nombre}":`, p.stakeholders.join('; '));
  if (correos === null) return;
  const all = LS.projects();
  const target = all.find(x => x.id === p.id);
  target.stakeholders = correos.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  LS.setProjects(all);
  cargarProyectos(p.id);
});

// ---------- Generación con Gemini ----------

const GEMINI_SCHEMA = {
  type: 'OBJECT',
  properties: {
    fecha_reunion: { type: 'STRING' },
    participantes: { type: 'ARRAY', items: { type: 'STRING' } },
    proxima_reunion: { type: 'STRING', nullable: true },
    acuerdos: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          id: { type: 'STRING', nullable: true },
          accion: { type: 'STRING' },
          responsable: { type: 'STRING' },
          estado: { type: 'STRING', enum: ESTADOS },
          fecha_comprometida: { type: 'STRING' },
          critico: { type: 'BOOLEAN' },
          fecha_cierre: { type: 'STRING', nullable: true },
        },
        required: ['accion', 'responsable', 'estado', 'fecha_comprometida', 'critico'],
      },
    },
  },
  required: ['fecha_reunion', 'participantes', 'acuerdos'],
};

function buildSystemPrompt(projectName, hoy, lunesSemana) {
  return `Eres Scribe, el asistente de PMO de Minsait para el proyecto "${projectName}" en Antamina.

Con base en la transcripción de una reunión de Teams y la lista de acuerdos históricos abiertos del proyecto, genera una minuta accionable de seguimiento para enviar por correo a los participantes e involucrados del proyecto.

Fecha actual: ${hoy}. La semana actual inicia el lunes ${lunesSemana}.

Instrucciones:
- Identifica la fecha de la reunión, los participantes y la próxima reunión programada, si se mencionan en la transcripción.
- Extrae todos los acuerdos, acciones y compromisos de la transcripción.
- Cruza la transcripción con los acuerdos históricos abiertos: si un acuerdo histórico se menciona como avanzado, completado, reprogramado u observado, actualiza su estado, fecha comprometida o fecha de cierre, conservando su id. Los acuerdos históricos que no se mencionan se mantienen sin cambios (mismo id, mismo estado).
- Los acuerdos nuevos detectados en la transcripción llevan id null.
- Redacta las acciones en lenguaje formal, claro y accionable (verbo + entregable + contexto necesario).
- Si una fecha no está indicada, usa "Por definir".
- Estados permitidos: Pendiente, Programado, En curso, Observado, Completado.
- Si un acuerdo se cerró en la reunión, marca estado Completado y fecha_cierre con la fecha de la reunión.
- Marca critico=true únicamente en acuerdos realmente críticos: bloquean el avance, tienen riesgo alto o urgencia explícita en la conversación.
- No inventes acuerdos, responsables ni fechas que no tengan sustento en la transcripción o en los históricos.`;
}

async function callGemini(system, userMessage) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': LS.key() },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: GEMINI_SCHEMA, temperature: 0.2 },
    }),
  });
  if (!r.ok) {
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      throw new Error('API key inválida o sin permisos. Revisa la configuración (botón ⚙ API key).');
    }
    throw new Error(`Error de Gemini (${r.status}). Inténtalo de nuevo.`);
  }
  const data = await r.json();
  const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '';
  if (!text) throw new Error(`Gemini no devolvió contenido (${data.candidates?.[0]?.finishReason || 'sin detalle'})`);
  const minuta = JSON.parse(text);
  minuta.proxima_reunion = minuta.proxima_reunion || null;
  minuta.acuerdos = (minuta.acuerdos || []).map(a => ({ ...a, id: a.id || null, fecha_cierre: a.fecha_cierre || null }));
  return minuta;
}

$('btnGenerar').addEventListener('click', async () => {
  const p = proyectoActual();
  if (!p) return setStatus('status', 'Selecciona o crea un proyecto.', true);
  if (!LS.key()) {
    $('panelConfig').classList.remove('hidden');
    refreshKeyStatus();
    return setStatus('status', 'Configura tu API key de Gemini primero (botón ⚙).', true);
  }
  const transcript = $('transcript').value.trim();
  if (!transcript) return setStatus('status', 'Pega la transcripción primero.', true);

  const hoy = hoyISO();
  const lunesSemana = lunesDeLaSemana(hoy);
  const historicosAbiertos = LS.acuerdos(p.id).filter(a => a.estado !== 'Completado');
  const system = buildSystemPrompt(p.nombre, hoy, lunesSemana);
  const userMessage =
`ACUERDOS HISTÓRICOS ABIERTOS DEL PROYECTO (JSON):
${JSON.stringify(historicosAbiertos.map(({ id, accion, responsable, estado, fecha_comprometida, critico }) => ({ id, accion, responsable, estado, fecha_comprometida, critico })), null, 2)}

TRANSCRIPCIÓN DE LA REUNIÓN:
${transcript}`;

  $('btnGenerar').disabled = true;
  setStatus('status', 'Scribe está redactando la minuta... (puede tomar un momento)');
  try {
    const minuta = await callGemini(system, userMessage);
    minuta.acuerdos = minuta.acuerdos.filter(a => visibleEnMinuta(a, lunesSemana));
    pintarMinuta(minuta);
    setStatus('status', 'Minuta generada. Revisa y ajusta en el paso 2.');
    $('paso2').classList.remove('hidden');
    $('paso2').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setStatus('status', e.message, true);
  } finally {
    $('btnGenerar').disabled = false;
  }
});

function setStatus(id, msg, isError) {
  const el = $(id);
  el.textContent = msg;
  el.classList.toggle('error', Boolean(isError));
}

// ---------- Tabla editable ----------

function pintarMinuta(m) {
  $('fechaReunion').value = /^\d{4}-\d{2}-\d{2}$/.test(m.fecha_reunion) ? m.fecha_reunion : '';
  $('participantes').value = (m.participantes || []).join(', ');
  $('proximaReunion').value = m.proxima_reunion || '';
  const tbody = $('tablaAcuerdos').querySelector('tbody');
  tbody.innerHTML = '';
  (m.acuerdos || []).forEach(a => tbody.appendChild(crearFila(a)));
  renumerar();
}

function crearFila(a = {}) {
  const tr = document.createElement('tr');
  tr.dataset.id = a.id || '';
  tr.dataset.fechaCierre = a.fecha_cierre || '';
  tr.dataset.createdAt = a.created_at || '';
  if (a.critico) tr.classList.add('critico');
  tr.innerHTML = `
    <td class="num"></td>
    <td><textarea class="f-accion">${a.accion || ''}</textarea></td>
    <td><input class="f-responsable" value="${(a.responsable || '').replace(/"/g, '&quot;')}"></td>
    <td><select class="f-estado">${ESTADOS.map(e => `<option ${e === a.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
    <td><input class="f-fecha" value="${a.fecha_comprometida || 'Por definir'}"></td>
    <td class="center"><input type="checkbox" class="f-critico" ${a.critico ? 'checked' : ''}></td>
    <td class="center"><button class="btn-del" title="Eliminar">✕</button></td>`;
  tr.querySelector('.f-critico').addEventListener('change', e => {
    tr.classList.toggle('critico', e.target.checked);
  });
  tr.querySelector('.btn-del').addEventListener('click', () => { tr.remove(); renumerar(); });
  return tr;
}

function renumerar() {
  [...$('tablaAcuerdos').querySelectorAll('tbody tr')].forEach((tr, i) => {
    tr.querySelector('.num').textContent = i + 1;
  });
}

$('btnAgregarFila').addEventListener('click', () => {
  $('tablaAcuerdos').querySelector('tbody').appendChild(crearFila());
  renumerar();
});

function leerMinuta() {
  const acuerdos = [...$('tablaAcuerdos').querySelectorAll('tbody tr')].map(tr => ({
    id: tr.dataset.id || null,
    accion: tr.querySelector('.f-accion').value.trim(),
    responsable: tr.querySelector('.f-responsable').value.trim() || 'Por definir',
    estado: tr.querySelector('.f-estado').value,
    fecha_comprometida: tr.querySelector('.f-fecha').value.trim() || 'Por definir',
    critico: tr.querySelector('.f-critico').checked,
    fecha_cierre: tr.querySelector('.f-estado').value === 'Completado'
      ? (tr.dataset.fechaCierre || hoyISO())
      : null,
    created_at: tr.dataset.createdAt || undefined,
  })).filter(a => a.accion);

  return {
    fecha_reunion: $('fechaReunion').value || hoyISO(),
    participantes: $('participantes').value.split(',').map(s => s.trim()).filter(Boolean),
    proxima_reunion: $('proximaReunion').value.trim() || null,
    acuerdos,
  };
}

// ---------- Guardar seguimiento ----------

function guardar() {
  const p = proyectoActual();
  const m = leerMinuta();
  const existentes = LS.acuerdos(p.id);
  const hoy = hoyISO();
  const idsActualizados = new Set();

  const actualizados = m.acuerdos.map(a => {
    const id = a.id || Math.random().toString(36).slice(2, 10);
    if (a.id) idsActualizados.add(a.id);
    return { ...a, id, updated_at: hoy, created_at: a.created_at || hoy };
  });

  const noTocados = existentes.filter(a => !idsActualizados.has(a.id));
  LS.setAcuerdos(p.id, [...noTocados, ...actualizados]);
  return m;
}

$('btnGuardar').addEventListener('click', () => {
  guardar();
  setStatus('status2', 'Seguimiento guardado. Los acuerdos abiertos se cruzarán con la próxima minuta.');
});

// ---------- Render de correo y .eml ----------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderMinutaHtml(minuta, projectName) {
  const filas = minuta.acuerdos.map((a, i) => {
    const color = a.critico ? 'color:#C00000;font-weight:bold;' : 'color:#333333;';
    const fecha = a.fecha_comprometida && a.fecha_comprometida !== '' ? a.fecha_comprometida : 'Por definir';
    return `<tr>
      <td style="border:1px solid #BFBFBF;padding:6px 8px;text-align:center;${color}">${i + 1}</td>
      <td style="border:1px solid #BFBFBF;padding:6px 8px;${color}">${esc(a.accion)}</td>
      <td style="border:1px solid #BFBFBF;padding:6px 8px;${color}">${esc(a.responsable)}</td>
      <td style="border:1px solid #BFBFBF;padding:6px 8px;text-align:center;${color}">${esc(a.estado)}</td>
      <td style="border:1px solid #BFBFBF;padding:6px 8px;text-align:center;${color}">${esc(fecha)}</td>
    </tr>`;
  }).join('\n');

  const participantes = (minuta.participantes || []).length
    ? `<p style="margin:4px 0;"><b>Participantes:</b> ${esc(minuta.participantes.join(', '))}</p>` : '';
  const proxima = minuta.proxima_reunion
    ? `<p style="margin:4px 0;"><b>Próxima reunión:</b> ${esc(minuta.proxima_reunion)}</p>` : '';

  return `<div style="font-family:Calibri,Arial,sans-serif;font-size:11pt;color:#333333;">
  <p>Estimados, buen día:</p>
  <p>Comparto la minuta de seguimiento de la reunión del proyecto <b>${esc(projectName)}</b>.</p>
  <p style="margin:4px 0;"><b>Fecha de reunión:</b> ${esc(fechaLarga(minuta.fecha_reunion))}</p>
  ${participantes}
  ${proxima}
  <p style="margin:14px 0 6px 0;"><b>Detalle de seguimiento:</b></p>
  <table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:10.5pt;width:100%;max-width:900px;">
    <tr style="background-color:#1F3864;color:#FFFFFF;">
      <th style="border:1px solid #BFBFBF;padding:6px 8px;">N°</th>
      <th style="border:1px solid #BFBFBF;padding:6px 8px;">Acción / Compromiso</th>
      <th style="border:1px solid #BFBFBF;padding:6px 8px;">Responsable</th>
      <th style="border:1px solid #BFBFBF;padding:6px 8px;">Estado</th>
      <th style="border:1px solid #BFBFBF;padding:6px 8px;">Fecha comprometida</th>
    </tr>
    ${filas}
  </table>
  <p style="margin-top:16px;">Agradeceré su apoyo con la atención de las acciones pendientes y programadas según las fechas comprometidas.</p>
  <p>Saludos cordiales,</p>
</div>`;
}

$('btnPreview').addEventListener('click', () => {
  const p = proyectoActual();
  const m = leerMinuta();
  $('paso3').classList.remove('hidden');
  $('previewFrame').srcdoc = renderMinutaHtml(m, p.nombre);
  $('paso3').scrollIntoView({ behavior: 'smooth' });
});

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

$('btnEml').addEventListener('click', () => {
  const p = proyectoActual();
  if (!p) return;
  if (!p.stakeholders.length && !confirm('Este proyecto no tiene correos configurados. ¿Descargar el .eml sin destinatarios?')) return;
  const m = guardar();
  const html = renderMinutaHtml(m, p.nombre);
  const [y, mo, d] = m.fecha_reunion.split('-');
  const subject = `Minuta de seguimiento – ${p.nombre} – ${d}/${mo}/${y}`;
  const body = `<html><body>${html}</body></html>`;

  // X-Unsent: 1 hace que Outlook lo abra como borrador listo para enviar
  const eml = [
    `To: ${p.stakeholders.join('; ')}`,
    `Subject: =?utf-8?B?${b64utf8(subject)}?=`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    b64utf8(body).replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');

  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  a.download = `Minuta ${p.nombre} ${d}-${mo}-${y}.eml`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('status2', 'Seguimiento guardado y .eml descargado. Ábrelo con Outlook: saldrá como borrador listo para enviar.');
});

// ---------- Init ----------

cargarProyectos();
if (!LS.key()) { $('panelConfig').classList.remove('hidden'); refreshKeyStatus(); }
