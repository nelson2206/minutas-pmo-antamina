const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const fs = require('fs');
const crypto = require('crypto');
const Anthropic = require('@anthropic-ai/sdk');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const ACUERDOS_DIR = path.join(DATA_DIR, 'acuerdos');
const PROJECTS_FILE = path.join(DATA_DIR, 'projects.json');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || 'falta-configurar-api-key',
});

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Persistencia ----------

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function getProjects() {
  return readJson(PROJECTS_FILE, []);
}

function getAcuerdos(projectId) {
  return readJson(path.join(ACUERDOS_DIR, `${projectId}.json`), []);
}

function saveAcuerdos(projectId, acuerdos) {
  writeJson(path.join(ACUERDOS_DIR, `${projectId}.json`), acuerdos);
}

// ---------- Utilidades de fechas ----------

function hoyISO() {
  return new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Lima' }); // YYYY-MM-DD
}

function lunesDeLaSemana(isoDate) {
  const d = new Date(isoDate + 'T12:00:00');
  const day = d.getDay(); // 0=domingo
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

// ---------- Proyectos ----------

app.get('/api/projects', (req, res) => {
  res.json(getProjects());
});

app.post('/api/projects', (req, res) => {
  const { nombre, stakeholders } = req.body;
  if (!nombre) return res.status(400).json({ error: 'Falta el nombre del proyecto' });
  const projects = getProjects();
  const project = {
    id: crypto.randomUUID().slice(0, 8),
    nombre: nombre.trim(),
    stakeholders: (stakeholders || []).map(s => s.trim()).filter(Boolean),
  };
  projects.push(project);
  writeJson(PROJECTS_FILE, projects);
  res.json(project);
});

app.put('/api/projects/:id', (req, res) => {
  const projects = getProjects();
  const project = projects.find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: 'Proyecto no encontrado' });
  if (req.body.nombre) project.nombre = req.body.nombre.trim();
  if (req.body.stakeholders) project.stakeholders = req.body.stakeholders.map(s => s.trim()).filter(Boolean);
  writeJson(PROJECTS_FILE, projects);
  res.json(project);
});

app.get('/api/acuerdos/:projectId', (req, res) => {
  res.json(getAcuerdos(req.params.projectId));
});

// ---------- Generación de minuta con Claude ----------

const MINUTA_SCHEMA = {
  type: 'object',
  properties: {
    fecha_reunion: { type: 'string', description: 'Fecha de la reunión en formato YYYY-MM-DD. Si no se menciona en la transcripción, usar la fecha actual.' },
    participantes: { type: 'array', items: { type: 'string' }, description: 'Nombres de los participantes identificados en la transcripción.' },
    proxima_reunion: { type: ['string', 'null'], description: 'Fecha y hora de la próxima reunión si se menciona, en texto legible. Null si no se menciona.' },
    acuerdos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: ['string', 'null'], description: 'Id del acuerdo histórico si corresponde a uno existente; null si es un acuerdo nuevo detectado en la transcripción.' },
          accion: { type: 'string', description: 'Acción o compromiso en lenguaje formal, claro y accionable.' },
          responsable: { type: 'string', description: 'Persona o área responsable. "Por definir" si no se identifica.' },
          estado: { type: 'string', enum: ['Pendiente', 'Programado', 'En curso', 'Observado', 'Completado'] },
          fecha_comprometida: { type: 'string', description: 'Fecha comprometida YYYY-MM-DD, o "Por definir" si no está indicada.' },
          critico: { type: 'boolean', description: 'True solo si el acuerdo es crítico (bloquea el proyecto, riesgo alto o urgencia explícita).' },
          fecha_cierre: { type: ['string', 'null'], description: 'Fecha YYYY-MM-DD en que se completó el acuerdo. Solo para estado Completado; null en cualquier otro caso.' }
        },
        required: ['id', 'accion', 'responsable', 'estado', 'fecha_comprometida', 'critico', 'fecha_cierre'],
        additionalProperties: false
      }
    }
  },
  required: ['fecha_reunion', 'participantes', 'proxima_reunion', 'acuerdos'],
  additionalProperties: false
};

function buildSystemPrompt(projectName, hoy, lunesSemana) {
  return `Eres un asistente de PMO de Minsait para el proyecto "${projectName}" en Antamina.

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

app.post('/api/generate', async (req, res) => {
  const { projectId, transcript } = req.body;
  if (!transcript || !transcript.trim()) return res.status(400).json({ error: 'La transcripción está vacía' });
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return res.status(400).json({ error: 'Selecciona un proyecto válido' });

  const hoy = hoyISO();
  const lunesSemana = lunesDeLaSemana(hoy);
  const historicosAbiertos = getAcuerdos(projectId).filter(a => a.estado !== 'Completado');

  try {
    const response = await anthropic.messages.create({
      model: 'claude-opus-4-8',
      max_tokens: 16000,
      thinking: { type: 'adaptive' },
      system: buildSystemPrompt(project.nombre, hoy, lunesSemana),
      output_config: { format: { type: 'json_schema', schema: MINUTA_SCHEMA } },
      messages: [{
        role: 'user',
        content:
`ACUERDOS HISTÓRICOS ABIERTOS DEL PROYECTO (JSON):
${JSON.stringify(historicosAbiertos.map(({ id, accion, responsable, estado, fecha_comprometida, critico }) => ({ id, accion, responsable, estado, fecha_comprometida, critico })), null, 2)}

TRANSCRIPCIÓN DE LA REUNIÓN:
${transcript}`
      }]
    });

    if (response.stop_reason === 'refusal') {
      return res.status(422).json({ error: 'El modelo declinó procesar esta transcripción. Revisa el contenido e inténtalo de nuevo.' });
    }

    const textBlock = response.content.find(b => b.type === 'text');
    const minuta = JSON.parse(textBlock.text);
    minuta.lunes_semana = lunesSemana;
    minuta.acuerdos = minuta.acuerdos.filter(a => visibleEnMinuta(a, lunesSemana));
    res.json({ minuta, project });
  } catch (err) {
    console.error(err);
    const msg = err.status === 401
      ? 'API key inválida o no configurada. Revisa el archivo .env.'
      : `Error al generar la minuta: ${err.message}`;
    res.status(500).json({ error: msg });
  }
});

// ---------- Guardar acuerdos (seguimiento) ----------

app.post('/api/save', (req, res) => {
  const { projectId, acuerdos } = req.body;
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return res.status(400).json({ error: 'Proyecto no encontrado' });

  const existentes = getAcuerdos(projectId);
  const hoy = hoyISO();
  const idsActualizados = new Set();

  const actualizados = acuerdos.map(a => {
    const id = a.id || crypto.randomUUID().slice(0, 8);
    if (a.id) idsActualizados.add(a.id);
    return { ...a, id, updated_at: hoy, created_at: a.created_at || hoy };
  });

  // Conservar acuerdos existentes que no vinieron en esta minuta (completados históricos, etc.)
  const noTocados = existentes.filter(a => !idsActualizados.has(a.id));
  const resultado = [...noTocados, ...actualizados];
  saveAcuerdos(projectId, resultado);
  res.json({ ok: true, total: resultado.length });
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

app.post('/api/preview', (req, res) => {
  const { minuta, projectName } = req.body;
  res.json({ html: renderMinutaHtml(minuta, projectName) });
});

app.post('/api/eml', (req, res) => {
  const { minuta, projectId } = req.body;
  const project = getProjects().find(p => p.id === projectId);
  if (!project) return res.status(400).json({ error: 'Proyecto no encontrado' });

  const html = renderMinutaHtml(minuta, project.nombre);
  const [y, m, d] = (minuta.fecha_reunion || hoyISO()).split('-');
  const subject = `Minuta de seguimiento – ${project.nombre} – ${d}/${m}/${y}`;
  const body = `<html><body>${html}</body></html>`;

  // X-Unsent: 1 hace que Outlook lo abra como borrador listo para enviar
  const eml = [
    `To: ${project.stakeholders.join('; ')}`,
    `Subject: =?utf-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`,
    'X-Unsent: 1',
    'MIME-Version: 1.0',
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    Buffer.from(body, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n'),
  ].join('\r\n');

  res.setHeader('Content-Type', 'message/rfc822');
  res.setHeader('Content-Disposition', `attachment; filename="minuta.eml"`);
  res.send(eml);
});

app.listen(PORT, () => {
  console.log(`Minutas PMO Antamina en http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('ADVERTENCIA: ANTHROPIC_API_KEY no está configurada. Copia .env.example a .env y agrega tu key.');
  }
});
