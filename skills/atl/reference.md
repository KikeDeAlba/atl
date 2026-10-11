# Referencia de atl

Todos los comandos aceptan `--site <nombre|url>` y `--json`. La columna MCP es
la herramienta equivalente cuando atl está registrado como servidor MCP.

## Jira

| Tarea | CLI | MCP |
|---|---|---|
| Leer un issue | `atl jira issue get PP-1 [--fields summary,customfield_10016 --raw]` | `jira_get_issue` |
| Buscar (JQL) | `atl jira search "<JQL>" --limit 20 [--fields key,summary,status]` | `jira_search` |
| Crear uno | `atl jira issue create --project PP --type Story --summary "…" [--description @d.md] [--parent PP-1] [--estimate 3h]` | `jira_create_issue` |
| Crear jerarquía | `atl jira issue create-many --project PP --issues @plan.json` | `jira_create_issues` |
| Editar | `atl jira issue edit PP-1 --summary "…"` | `jira_edit_issue` |
| Asignar | `atl jira issue assign PP-1 <correo\|accountId>` | `jira_assign` |
| Transiciones posibles | `atl jira issue transitions PP-1` | `jira_transitions` |
| Transicionar | `atl jira issue transition PP-1 done [--comment "…"]` | `jira_transition` |
| Comentar | `atl jira comment add PP-1 --body @-` | `jira_add_comment` |
| Comentarios | `atl jira comment ls PP-1` | `jira_comments` |
| Worklog | `atl jira worklog add PP-1 --started <ISO> --time-spent "1h 30m"` | `jira_add_worklog` |
| Worklogs | `atl jira worklog ls PP-1` | `jira_worklogs` |
| Adjuntar | `atl jira attach PP-1 ./archivo.pdf` | `jira_attach` |
| Enlazar issues | `atl jira link Blocks PP-1 PP-2` | `jira_link` |
| Campos de un tipo | `atl jira createmeta PP Story` | `jira_create_meta` |
| Proyectos | `atl jira project ls [texto]` | `jira_projects` |
| Tableros y sprints | `atl jira board ls PP`, `atl jira sprint ls <board>`, `atl jira sprint add <sprint> --issues PP-1,PP-2` | `jira_boards`, `jira_sprints`, `jira_move_to_sprint` |

Claves de `jira search` para `--fields`: `id, key, url, summary, status,
statusCategory, issueType, parentKey, projectKey, assignee, reporter, priority,
labels, description, originalEstimateSeconds, timeSpentSeconds, created,
updated`. atl solo le pide a Jira los campos que corresponden a esas claves.

`plan.json` para `create-many`:

```json
[
  { "ref": "epic", "type": "Epic", "summary": "Pagos con CoDi" },
  { "ref": "s1", "parentRef": "epic", "type": "Story", "summary": "Cobro", "estimate": "1d" },
  { "parentRef": "s1", "type": "Subtask", "summary": "Webhook", "estimate": "3h" }
]
```

La estimación usa notación de Jira (`"2h"`, `"1d 4h"`).

## Confluence

| Tarea | CLI | MCP |
|---|---|---|
| Leer página | `atl confluence page get 123` | `confluence_get_page` |
| Buscar por título | `atl confluence page find DOC "Título"` | `confluence_find_page` |
| Publicar por título | `atl confluence page upsert DOC "Título" --body @pagina.md` | `confluence_upsert_page` |
| Crear | `atl confluence page create DOC "Título" --body @pagina.md --parent-id 456` | `confluence_create_page` |
| Actualizar | `atl confluence page update 123 --body @pagina.md --message "…"` | `confluence_update_page` |
| Hijas / árbol | `atl confluence page children 123`, `atl confluence page tree 123` | `confluence_children`, `confluence_descendants` |
| Buscar (CQL) | `atl confluence search '<CQL>' --limit 10` | `confluence_search` |
| Adjuntar | `atl confluence attach 123 ./diagrama.png` | `confluence_attach` |
| Comentarios | `atl confluence comment add 123 --body @-`, `atl confluence comment ls 123` | `confluence_add_comment`, `confluence_comments` |
| Etiquetas | `atl confluence label ls 123`, `atl confluence label add 123 --labels a,b` | `confluence_labels`, `confluence_add_labels` |
| Espacios | `atl confluence space ls` | `confluence_spaces` |

- `--format storage` cuando ya tienes XHTML de storage en vez de Markdown.
- Las imágenes locales del Markdown (`![](diagrama.png)`) se publican como
  adjuntos: súbelas con `confluence attach`.
- `update` incrementa la versión solo.

## API completa

1. `atl api search "create version"` busca entre las 1073 operaciones REST.
2. `atl api describe jira.createVersion` muestra parámetros y cuerpo.
3. `atl api call jira.createVersion --args '{"body":{"name":"1.0","projectId":10000}}'`
   (parámetros por nombre; el cuerpo en `body`; subidas con `file`).

MCP: `api_search`, `api_describe`, `api_call`.
