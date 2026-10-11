---
name: atl
description: Trabaja con Jira, Jira Software y Confluence Cloud en uno o varios sitios de Atlassian por medio de la CLI atl. Úsala para leer, buscar, crear o editar issues, épicas, subtareas, worklogs, comentarios, transiciones, tableros y sprints, y para leer, publicar o actualizar páginas de Confluence a partir de Markdown. También cubre cualquier otra operación de las APIs REST de Jira y Confluence. Frases que la disparan: "crea la historia en Jira", "pasa esto a Confluence", "qué dice el ticket PP-123", "registra 2 horas en", "muévelo a hecho", "busca en Confluence", "publica esta página".
allowed-tools: Bash(atl site ls:*), Bash(atl jira issue get:*), Bash(atl jira search:*), Bash(atl jira comment ls:*), Bash(atl jira worklog ls:*), Bash(atl jira createmeta:*), Bash(atl jira issue transitions:*), Bash(atl confluence page get:*), Bash(atl confluence page find:*), Bash(atl confluence page tree:*), Bash(atl confluence search:*), Bash(atl api search:*), Bash(atl api describe:*), Bash(atl --version)
---

# atl

`atl` es el único camino a Jira, Jira Software y Confluence Cloud. Úsalo desde
la terminal, siempre con `--json` (respuesta `{ ok, data }` o `{ ok, error }`).
Si en este cliente atl está registrado como servidor MCP, las herramientas
`jira_*`, `confluence_*` y `api_*` hacen las mismas operaciones, pero devuelven
objetos completos: la proyección con `--fields` es solo de la CLI.

Quién hace qué: atl habla con Jira y Confluence; bita lleva el tiempo, tally lo
vuelca a Jira, inkwell documenta y recap graba reuniones.

## Gastar poco contexto

- Los listados (`jira search`, `confluence search`, `page tree`, `space ls`,
  `comment ls`, …) aceptan `--limit <n>` y `--fields a,b,c`.
- Sin `--fields`, devuelven objetos compactos: `jira search` trae solo
  `key, summary, status, assignee`; `confluence search` trae
  `id, type, title, space`. Pide con `--fields` solo lo que vas a usar
  (`--fields key,summary,parentKey,originalEstimateSeconds`); `--fields all`
  trae el objeto completo.
- Pon siempre `--limit` en las búsquedas y acota el JQL o el CQL.
- Para el detalle de un solo issue o página usa `issue get` o `page get`.

## Lo de todos los días

```sh
atl site ls --json
atl jira search "project = PP AND status != Done ORDER BY updated DESC" --limit 20 --json
atl jira issue get PP-1 --json
atl jira issue create --project PP --type Story --summary "…" --description @desc.md --estimate 3h --json
atl jira issue create-many --project PP --issues @plan.json --json
atl jira issue edit PP-1 --summary "…" --json
atl jira issue transition PP-1 done --json
atl jira worklog add PP-1 --started 2026-10-10T09:00:00-06:00 --time-spent "1h 30m" --json
atl jira comment add PP-1 --body @- --json
atl jira createmeta PP Story --json
atl confluence page get 123 --json
atl confluence page upsert DOC "Título" --body @pagina.md --json
atl confluence search 'space = DOC AND title ~ "deploy"' --limit 10 --json
```

`atl <comando> --help` lista las opciones de cada comando. La tabla completa de
comandos y herramientas MCP está en [reference.md](reference.md).

## Reglas

- **Sitios**: `--site <nombre|url>` elige el sitio; sin él se usa el marcado
  como `default`. Si falla con `LOGIN_REQUIRED`, pide al usuario que corra en su
  terminal `atl site add https://<sitio>.atlassian.net --email <correo>`. Nunca
  pidas el API token en la conversación.
- **Markdown**: descripciones, comentarios y páginas van en Markdown; atl los
  convierte. Cualquier valor acepta `@archivo` y `@-` (stdin).
- **Antes de crear** en un proyecto que no conoces, consulta `jira createmeta`
  para saber tipos y campos obligatorios.
- **Jerarquías**: `issue create-many` crea épica → historias → subtareas en una
  llamada (`ref` y `parentRef`). Si uno falla devuelve lo creado: no lo repitas.
- **Transiciones**: aceptan id, nombre de la transición o del estado destino;
  `done` va a cualquier estado de la categoría terminado.
- **Lo que no cubre un comando**: `atl api search "<palabras>"` →
  `atl api describe <id>` → `atl api call <id> --args '{…}'`.
- **Borrar** (`issue delete`, `comment rm`, `page delete`): confírmalo antes con
  el usuario.
- No inventes claves de issue ni ids de página: búscalos primero.
