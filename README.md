# Minutas PMO Antamina

Herramienta web para el equipo PMO de Antamina (Minsait): pega la transcripción de una llamada de Teams y genera una minuta accionable de seguimiento, lista para enviar por correo a los interesados del proyecto.

## Qué hace

1. **Genera la minuta con IA** (Claude Opus 4.8) a partir de la transcripción: fecha, participantes, próxima reunión y tabla de acuerdos (N°, Acción/Compromiso, Responsable, Estado, Fecha comprometida).
2. **Seguimiento de acuerdos por proyecto**: los acuerdos abiertos se guardan y se cruzan automáticamente con la siguiente minuta (actualiza estados, detecta cierres, agrega nuevos).
3. **Reglas de la minuta**: muestra pendientes/programados/en curso/observados; completados solo si se cerraron en la semana actual; texto rojo solo para acuerdos críticos; "Por definir" cuando falta fecha; cierre formal fijo.
4. **Correo a interesados**: descarga un `.eml` que Outlook abre como borrador con los destinatarios del proyecto ya cargados.

## Instalación

```bash
npm install
copy .env.example .env   # y pega tu ANTHROPIC_API_KEY
npm start
```

Abre http://localhost:3000

## Estructura de datos

- `data/projects.json` — proyectos y sus correos de interesados.
- `data/acuerdos/<projectId>.json` — historial de acuerdos por proyecto (base del seguimiento y de futuros recordatorios automáticos).
