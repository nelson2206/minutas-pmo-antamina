const $ = id => document.getElementById(id);
const ESTADOS = ['Pendiente', 'Programado', 'En curso', 'Observado', 'Completado'];

let projects = [];
let minutaActual = null;

// ---------- Proyectos ----------

async function cargarProyectos(selectedId) {
  projects = await fetch('/api/projects').then(r => r.json());
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

$('btnNuevoProyecto').addEventListener('click', async () => {
  const nombre = prompt('Nombre del proyecto:');
  if (!nombre) return;
  const correos = prompt('Correos de los interesados (separados por coma o punto y coma):') || '';
  const stakeholders = correos.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  const p = await fetch('/api/projects', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nombre, stakeholders }),
  }).then(r => r.json());
  await cargarProyectos(p.id);
});

$('btnEditarProyecto').addEventListener('click', async () => {
  const p = proyectoActual();
  if (!p) return alert('Selecciona un proyecto primero.');
  const correos = prompt(`Correos de los interesados de "${p.nombre}":`, p.stakeholders.join('; '));
  if (correos === null) return;
  const stakeholders = correos.split(/[,;]/).map(s => s.trim()).filter(Boolean);
  await fetch(`/api/projects/${p.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stakeholders }),
  });
  await cargarProyectos(p.id);
});

// ---------- Generar minuta ----------

$('btnGenerar').addEventListener('click', async () => {
  const p = proyectoActual();
  if (!p) return setStatus('status', 'Selecciona o crea un proyecto.', true);
  const transcript = $('transcript').value.trim();
  if (!transcript) return setStatus('status', 'Pega la transcripción primero.', true);

  $('btnGenerar').disabled = true;
  setStatus('status', 'Generando minuta con IA... (puede tomar un momento)');
  try {
    const r = await fetch('/api/generate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: p.id, transcript }),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error);
    minutaActual = data.minuta;
    pintarMinuta(data.minuta);
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
      ? (tr.dataset.fechaCierre || new Date().toISOString().slice(0, 10))
      : null,
    created_at: tr.dataset.createdAt || undefined,
  })).filter(a => a.accion);

  return {
    fecha_reunion: $('fechaReunion').value || new Date().toISOString().slice(0, 10),
    participantes: $('participantes').value.split(',').map(s => s.trim()).filter(Boolean),
    proxima_reunion: $('proximaReunion').value.trim() || null,
    acuerdos,
  };
}

// ---------- Acciones ----------

$('btnPreview').addEventListener('click', async () => {
  const p = proyectoActual();
  const m = leerMinuta();
  const { html } = await fetch('/api/preview', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ minuta: m, projectName: p.nombre }),
  }).then(r => r.json());
  $('paso3').classList.remove('hidden');
  $('previewFrame').srcdoc = html;
  $('paso3').scrollIntoView({ behavior: 'smooth' });
});

async function guardar() {
  const p = proyectoActual();
  const m = leerMinuta();
  const r = await fetch('/api/save', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectId: p.id, acuerdos: m.acuerdos }),
  });
  if (!r.ok) throw new Error((await r.json()).error);
  return m;
}

$('btnGuardar').addEventListener('click', async () => {
  try {
    await guardar();
    setStatus('status2', 'Seguimiento guardado. Los acuerdos abiertos se cruzarán con la próxima minuta.');
  } catch (e) {
    setStatus('status2', e.message, true);
  }
});

$('btnEml').addEventListener('click', async () => {
  const p = proyectoActual();
  if (!p.stakeholders.length && !confirm('Este proyecto no tiene correos configurados. ¿Descargar el .eml sin destinatarios?')) return;
  try {
    const m = await guardar();
    const r = await fetch('/api/eml', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ projectId: p.id, minuta: m }),
    });
    if (!r.ok) throw new Error((await r.json()).error);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    const [y, mo, d] = m.fecha_reunion.split('-');
    a.download = `Minuta ${p.nombre} ${d}-${mo}-${y}.eml`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus('status2', 'Seguimiento guardado y .eml descargado. Ábrelo con Outlook: saldrá como borrador listo para enviar.');
  } catch (e) {
    setStatus('status2', e.message, true);
  }
});

cargarProyectos();
