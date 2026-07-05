const $ = id => document.getElementById(id);
const ESTADOS = ['Pendiente', 'Programado', 'En curso', 'Observado', 'Completado'];
const GEMINI_MODEL = 'gemini-2.5-flash';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

// ---------- Toasts ----------

function toast(msg, type = 'ok') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  $('toastWrap').appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 4200);
}

// ---------- Barra de pasos ----------

function setStep(n) {
  document.querySelectorAll('.step').forEach(s => {
    const step = +s.dataset.step;
    s.classList.toggle('is-active', step === n);
    s.classList.toggle('is-done', step < n);
  });
}

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
  if (LS.key()) { $('panelConfig').classList.add('hidden'); toast('API key guardada en este navegador.'); }
});

// ---------- Proyectos ----------

function cargarProyectos(selectedId) {
  projects = LS.projects();
  const sel = $('projectSelect');
  sel.innerHTML = projects.length
    ? projects.map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')
    : '<option value="">— Crea un proyecto primero —</option>';
  if (selectedId) sel.value = selectedId;
  actualizarHint();
}

function proyectoActual() {
  return projects.find(p => p.id === $('projectSelect').value);
}

function chipHtml(correo, invalido) {
  return `<span class="chip${invalido ? ' invalid' : ''}">${esc(correo)}</span>`;
}

function actualizarHint() {
  const p = proyectoActual();
  const box = $('stakeholdersHint');
  if (!p) { box.innerHTML = ''; return; }
  if (!p.stakeholders.length) {
    box.innerHTML = '<span class="lead">Para</span><span class="none">sin correos configurados — usa ✎ Destinatarios</span>';
    return;
  }
  box.innerHTML = '<span class="lead">Para</span>' + p.stakeholders.map(c => chipHtml(c, !EMAIL_RE.test(c))).join('');
}

$('projectSelect').addEventListener('change', actualizarHint);

// ---------- Modal de proyecto (crear / editar) con chips ----------

let modalMode = 'new';      // 'new' | 'edit'
let modalProjectId = null;
let modalEmails = [];       // array de correos en edición

function renderChips() {
  $('chipsList').innerHTML = modalEmails.map((c, i) =>
    `<span class="chip${EMAIL_RE.test(c) ? '' : ' invalid'}" data-i="${i}">${esc(c)} <span class="x" data-i="${i}">×</span></span>`
  ).join('');
}

function addEmails(raw) {
  raw.split(/[\s,;]+/).map(s => s.trim()).filter(Boolean).forEach(correo => {
    if (!modalEmails.includes(correo)) modalEmails.push(correo);
  });
  renderChips();
}

function abrirModal(mode, project) {
  modalMode = mode;
  modalProjectId = project ? project.id : null;
  modalEmails = project ? [...project.stakeholders] : [];
  $('modalTitle').textContent = mode === 'new' ? 'Nuevo proyecto' : `Destinatarios · ${project.nombre}`;
  $('modalNombre').value = project ? project.nombre : '';
  $('modalNombre').parentElement.style.display = mode === 'new' ? '' : 'none';
  $('chipEntry').value = '';
  renderChips();
  $('projectModal').classList.remove('hidden');
  setTimeout(() => (mode === 'new' ? $('modalNombre') : $('chipEntry')).focus(), 50);
}

function cerrarModal() { $('projectModal').classList.add('hidden'); }

$('btnNuevoProyecto').addEventListener('click', () => abrirModal('new'));
$('btnEditarProyecto').addEventListener('click', () => {
  const p = proyectoActual();
  if (!p) return toast('Crea un proyecto primero.', 'error');
  abrirModal('edit', p);
});

$('chipEntry').addEventListener('keydown', e => {
  if (['Enter', ',', ';', ' '].includes(e.key)) {
    e.preventDefault();
    if (e.target.value.trim()) { addEmails(e.target.value); e.target.value = ''; }
  } else if (e.key === 'Backspace' && !e.target.value && modalEmails.length) {
    modalEmails.pop(); renderChips();
  }
});
$('chipEntry').addEventListener('blur', e => { if (e.target.value.trim()) { addEmails(e.target.value); e.target.value = ''; } });
$('chipEntry').addEventListener('paste', e => {
  e.preventDefault();
  addEmails((e.clipboardData || window.clipboardData).getData('text'));
});
$('chipsInput').addEventListener('click', () => $('chipEntry').focus());
$('chipsList').addEventListener('click', e => {
  const x = e.target.closest('.x');
  if (x) { modalEmails.splice(+x.dataset.i, 1); renderChips(); }
});

$('modalCancel').addEventListener('click', cerrarModal);
$('projectModal').addEventListener('click', e => { if (e.target.id === 'projectModal') cerrarModal(); });
document.addEventListener('keydown', e => { if (e.key === 'Escape') cerrarModal(); });

$('modalSave').addEventListener('click', () => {
  if ($('chipEntry').value.trim()) { addEmails($('chipEntry').value); $('chipEntry').value = ''; }
  const invalidos = modalEmails.filter(c => !EMAIL_RE.test(c));
  if (invalidos.length && !confirm(`Hay correos con formato inválido:\n${invalidos.join('\n')}\n\n¿Guardar de todas formas?`)) return;

  const all = LS.projects();
  if (modalMode === 'new') {
    const nombre = $('modalNombre').value.trim();
    if (!nombre) return toast('Escribe el nombre del proyecto.', 'error');
    const p = { id: Math.random().toString(36).slice(2, 10), nombre, stakeholders: modalEmails };
    all.push(p); LS.setProjects(all);
    cerrarModal(); cargarProyectos(p.id);
    toast('Proyecto creado.');
  } else {
    const target = all.find(x => x.id === modalProjectId);
    target.stakeholders = modalEmails;
    LS.setProjects(all);
    cerrarModal(); cargarProyectos(modalProjectId);
    toast('Destinatarios actualizados.');
  }
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

$('transcript').addEventListener('input', e => {
  $('transcriptCounter').textContent = `${e.target.value.length.toLocaleString('es-PE')} caracteres`;
});

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

  const btn = $('btnGenerar');
  btn.classList.add('loading');
  setStatus('status', 'Scribe está redactando la minuta...');
  try {
    const minuta = await callGemini(system, userMessage);
    minuta.acuerdos = minuta.acuerdos.filter(a => visibleEnMinuta(a, lunesSemana));
    pintarMinuta(minuta);
    setStatus('status', '');
    toast(`Minuta generada: ${minuta.acuerdos.length} acuerdo(s).`);
    $('paso2').classList.remove('hidden');
    setStep(2);
    $('paso2').scrollIntoView({ behavior: 'smooth' });
  } catch (e) {
    setStatus('status', e.message, true);
    toast(e.message, 'error');
  } finally {
    btn.classList.remove('loading');
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
    <td><textarea class="f-accion">${esc(a.accion || '')}</textarea></td>
    <td><input class="f-responsable" value="${esc(a.responsable || '')}"></td>
    <td><select class="f-estado">${ESTADOS.map(e => `<option ${e === a.estado ? 'selected' : ''}>${e}</option>`).join('')}</select></td>
    <td><input class="f-fecha" value="${esc(a.fecha_comprometida || 'Por definir')}"></td>
    <td class="center"><input type="checkbox" class="f-critico" ${a.critico ? 'checked' : ''}></td>
    <td class="center"><button class="btn-del" title="Eliminar">✕</button></td>`;
  tr.querySelector('.f-critico').addEventListener('change', e => tr.classList.toggle('critico', e.target.checked));
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
  toast('Seguimiento guardado. Se cruzará con la próxima minuta.');
});

// ---------- Render del correo ----------

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function subjectFor(m, projectName) {
  const [y, mo, d] = (m.fecha_reunion || hoyISO()).split('-');
  return `Minuta de seguimiento – ${projectName} – ${d}/${mo}/${y}`;
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
  if (!m.acuerdos.length) return toast('No hay acuerdos para incluir en la minuta.', 'error');
  $('previewRecipients').innerHTML = p.stakeholders.length
    ? p.stakeholders.map(c => chipHtml(c, !EMAIL_RE.test(c))).join('')
    : '<span class="none">Sin destinatarios — configúralos con ✎ Destinatarios</span>';
  $('previewSubject').textContent = subjectFor(m, p.nombre);
  $('previewFrame').srcdoc = renderMinutaHtml(m, p.nombre);
  $('paso3').classList.remove('hidden');
  setStep(3);
  $('paso3').scrollIntoView({ behavior: 'smooth' });
});

// ---------- Envío ----------

function b64utf8(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  bytes.forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
}

function htmlToText(html) {
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  return tmp.innerText.replace(/\n{3,}/g, '\n\n').trim();
}

$('btnEml').addEventListener('click', () => {
  const p = proyectoActual();
  if (!p) return;
  if (!p.stakeholders.length && !confirm('Este proyecto no tiene correos configurados. ¿Descargar el .eml sin destinatarios?')) return;
  const m = guardar();
  const html = renderMinutaHtml(m, p.nombre);
  const subject = subjectFor(m, p.nombre);
  const body = `<html><body>${html}</body></html>`;

  // X-Unsent: 1 hace que Outlook (escritorio) lo abra como borrador listo para enviar
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

  const [y, mo, d] = m.fecha_reunion.split('-');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([eml], { type: 'message/rfc822' }));
  a.download = `Minuta ${p.nombre} ${d}-${mo}-${y}.eml`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus('status3', 'Seguimiento guardado y .eml descargado. Ábrelo con Outlook: saldrá como borrador listo para enviar.');
  toast('.eml descargado.');
});

$('btnOutlookWeb').addEventListener('click', async () => {
  const p = proyectoActual();
  if (!p) return;
  const m = guardar();
  const html = renderMinutaHtml(m, p.nombre);
  const subject = subjectFor(m, p.nombre);

  let copiado = false;
  try {
    await navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([htmlToText(html)], { type: 'text/plain' }),
    })]);
    copiado = true;
  } catch {
    try { await navigator.clipboard.writeText(htmlToText(html)); copiado = true; } catch { /* sin permiso de portapapeles */ }
  }

  const to = p.stakeholders.join(';');
  const url = `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}`;
  window.open(url, '_blank', 'noopener');

  setStatus('status3', copiado
    ? 'Minuta copiada al portapapeles. En la ventana de Outlook web, haz clic en el cuerpo del correo y pega con Ctrl+V.'
    : 'Se abrió Outlook web con destinatarios y asunto. Vuelve a Scribe y usa "Descargar .eml" si necesitas el cuerpo con formato.');
  toast(copiado ? 'Minuta copiada — pega con Ctrl+V en Outlook web.' : 'Outlook web abierto.');
});

// ---------- Init ----------

cargarProyectos();
setStep(1);
if (!LS.key()) { $('panelConfig').classList.remove('hidden'); refreshKeyStatus(); }
