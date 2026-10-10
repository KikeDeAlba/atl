---
name: atl
description: Trabaja con Jira, Jira Software y Confluence Cloud en uno o varios sitios de Atlassian por medio de atl (CLI y servidor MCP). Úsala para leer, crear o editar issues, épicas, subtareas, worklogs, comentarios, transiciones, tableros y sprints, y para leer, publicar o actualizar páginas de Confluence a partir de Markdown. También cubre cualquier otra operación de las APIs REST de Jira y Confluence. Frases que la disparan: "crea la historia en Jira", "pasa esto a Confluence", "qué dice el ticket PP-123", "registra 2 horas en", "muévelo a hecho", "busca en Confluence", "publica esta página".
---

# atl

`atl` habla con Jira, Jira Software y Confluence Cloud. Funciona igual como
servidor MCP (herramientas `jira_*`, `confluence_*`, `api_*`) y como CLI
(`atl jira …`, `atl confluence …`, `atl api …`). Si las herramientas MCP de atl
están disponibles, úsalas; si no, usa la CLI con `--json`.

## Sitios

- Puede haber varios sitios configurados. `atl_sites` (o `atl site ls --json`)
  los lista; el marcado como `default` se usa cuando no se indica otro.
- Toda herramienta acepta `site` (nombre o URL). En la CLI es `--site`.
- Si falla con `LOGIN_REQUIRED`, pide al usuario que corra en su terminal
  `atl site add https://<sitio>.atlassian.net --email <correo>` y pegue un API
  token. Nunca pidas el token en la conversación.

## Formato

- Descripciones, comentarios y cuerpos de página van en **Markdown**. atl los
  convierte a Atlassian Document Format (Jira) o a storage (Confluence).
- Para Confluence existe `format: "storage"` cuando ya tienes XHTML de storage.
- Las respuestas traen descripciones y páginas convertidas a Markdown.

## Jira

| Tarea | MCP | CLI |
|---|---|---|
| Leer un issue | `jira_get_issue` | `atl jira issue get PP-1` |
| Buscar | `jira_search` (JQL) | `atl jira search "project = PP AND status != Done"` |
| Crear uno | `jira_create_issue` | `atl jira issue create --project PP --type Story --summary "…" --description @desc.md` |
| Crear jerarquía | `jira_create_issues` | `atl jira issue create-many --issues @plan.json --project PP` |
| Editar | `jira_edit_issue` | `atl jira issue edit PP-1 --summary "…"` |
| Transicionar | `jira_transition` | `atl jira issue transition PP-1 done` |
| Worklog | `jira_add_worklog` | `atl jira worklog add PP-1 --started 2026-10-10T09:00:00-06:00 --time-spent "1h 30m"` |
| Comentar | `jira_add_comment` | `atl jira comment add PP-1 --body @-` |
| Campos de un tipo | `jira_create_meta` | `atl jira createmeta PP Story` |

- `jira_create_issues` crea épica → historias → subtareas en una llamada: cada
  elemento lleva `ref` y los hijos `parentRef`. Si uno falla, devuelve lo creado
  y el error; no repitas lo que ya se creó.
- La estimación va en `estimate` con notación de Jira (`"2h"`, `"1d 4h"`).
- `transition` acepta id, nombre de la transición o nombre del estado destino;
  `done` elige cualquier transición hacia la categoría de terminado.
- Antes de crear en un proyecto que no conoces, consulta `jira_create_meta`
  para saber tipos y campos obligatorios.

## Confluence

| Tarea | MCP | CLI |
|---|---|---|
| Leer página | `confluence_get_page` | `atl confluence page get 123` |
| Publicar por título | `confluence_upsert_page` | `atl confluence page upsert DOC "Título" --body @pagina.md` |
| Crear | `confluence_create_page` | `atl confluence page create DOC "Título" --body @pagina.md --parent-id 456` |
| Actualizar | `confluence_update_page` | `atl confluence page update 123 --body @pagina.md --message "…"` |
| Árbol | `confluence_descendants` | `atl confluence page tree 123` |
| Buscar | `confluence_search` (CQL) | `atl confluence search 'space = DOC AND title ~ "deploy"'` |
| Adjuntar | `confluence_attach` | `atl confluence attach 123 ./diagrama.png` |

- Las imágenes locales en el Markdown (`![](diagrama.png)`) se publican como
  adjuntos de la página: súbelas con `confluence_attach` antes o después.
- `update` incrementa la versión solo; no hace falta leerla antes.

## Todo lo demás: la API completa

Cuando ninguna herramienta cubre lo que se pide (versiones, componentes,
filtros, permisos, restricciones de página, propiedades, webhooks, campos
personalizados, etc.):

1. `api_search` con palabras clave (`"create version"`, `"page restrictions"`).
2. `api_describe` con el id para ver parámetros y cuerpo.
3. `api_call` con `operation` y `args` (parámetros por nombre; el cuerpo JSON en
   `args.body`; subidas con `args.file`).

En la CLI: `atl api search …`, `atl api describe jira.createVersion`,
`atl api call jira.createVersion --args '{"body":{"name":"1.0","projectId":10000}}'`.

## Cuidado

- `jira_delete_issue`, `jira_delete_comment` y `confluence_delete_page` borran:
  confírmalo con el usuario antes.
- No inventes claves de issue ni ids de página: búscalos primero.
