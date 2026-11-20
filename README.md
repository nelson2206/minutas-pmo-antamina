# Scribe · Minutas PMO Antamina

Herramienta web para el equipo PMO de Antamina (Minsait): pega la transcripción de una llamada de Teams y genera una minuta accionable de seguimiento, lista para enviar por correo a los interesados del proyecto.

**Versión web (sin instalación):** https://minutas.mbc-latam.com — la página vive en [`docs/`](docs/) y los proyectos, acuerdos y minutas se guardan solo en el navegador de cada usuario. Para generar la minuta hay dos opciones (botón ⚙ Acceso a Gemini): el **código de equipo** (por defecto; la transcripción pasa por el Worker de Scribe hacia Gemini y no se guarda) o **la propia API key** de [Google AI Studio](https://aistudio.google.com/apikey) (directo a Google desde el navegador).

**Worker de Cloudflare (`worker/`):** `scribe-web` sirve `docs/` y el intermediario `POST /api/gemini` (clave y modelo fijos en el servidor, código de equipo en `x-scribe-code`, tope de 300 llamadas/día y 2 MB por pedido, sin guardar contenido, reporte de tokens a Pulse). Desplegar desde `worker/` con `npx wrangler deploy`. Secretos (los carga el administrador, nunca van en git): `npx wrangler secret put GEMINI_API_KEY` y `npx wrangler secret put ACCESS_CODE`. Prueba local sin gastar Gemini: ver `worker/test/prueba-local.mjs`.

**Versión servidor (este repo, raíz):** Node.js + Express con la API key en el servidor (`.env`) y datos en disco — para desplegar en Render/Vercel con una key compartida por el equipo.

## Qué hace

1. **Genera la minuta con IA** a partir de la transcripción: fecha, participantes, próxima reunión y tabla de acuerdos (N°, Acción/Compromiso, Responsable, Estado, Fecha comprometida). Soporta dos proveedores, configurables en `.env`: **Claude** (claude-opus-4-8) o **Gemini** (gemini-2.5-flash por defecto).
2. **Seguimiento de acuerdos por proyecto**: los acuerdos abiertos se guardan y se cruzan automáticamente con la siguiente minuta (actualiza estados, detecta cierres, agrega nuevos).
3. **Reglas de la minuta**: muestra pendientes/programados/en curso/observados; completados solo si se cerraron en la semana actual; texto rojo solo para acuerdos críticos; "Por definir" cuando falta fecha; cierre formal fijo.
4. **Correo a interesados**: descarga un `.eml` que Outlook abre como borrador con los destinatarios del proyecto ya cargados.

## Instalación

```bash
npm install
copy .env.example .env   # elige PROVIDER y pega tu API key (Anthropic o Gemini)
npm start
```

Abre http://localhost:3000

## Estructura de datos

- `data/projects.json` — proyectos y sus correos de interesados.
- `data/acuerdos/<projectId>.json` — historial de acuerdos por proyecto (base del seguimiento y de futuros recordatorios automáticos).
