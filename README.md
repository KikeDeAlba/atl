# atl

Jira, Jira Software y Confluence Cloud desde la terminal y como servidor MCP,
con varios sitios de Atlassian a la vez y la API REST completa.

- **CLI** con salida JSON (`--json`) para scripts y agentes.
- **Servidor MCP** por stdio (un cliente) o por HTTP local (varios clientes a la
  vez, con token).
- **Varios sitios**: cada uno con su cuenta y su API token, guardado en el
  llavero del sistema.
- **Markdown** de entrada y salida: atl convierte a Atlassian Document Format
  (Jira) y a storage (Confluence).
- **Toda la API**: 43 herramientas curadas para lo de todos los días y acceso a
  las 1073 operaciones REST de Jira, Jira Software y Confluence (v2 y v1),
  generadas desde los OpenAPI oficiales.

Es parte de las herramientas `@kikedealba` (bita, inkwell, recap, Den), pero no
depende de ninguna: se instala y se usa sola. Si las otras están instaladas, la
encuentran por el registro de [kit](https://github.com/KikeDeAlba/kit).

## Instalación

Node 24 o superior. macOS, Windows o Linux.

```sh
npm install -g @kikedealba/atl
atl setup
atl site add https://<empresa>.atlassian.net --email <tu@empresa.com>
```

`atl site add` pide el API token sin mostrarlo (créalo en
<https://id.atlassian.com/manage-profile/security/api-tokens>). También se puede
pasar por stdin: `pbpaste | atl site add <url> --email <correo> --token-stdin`.

`atl setup` registra atl en el registro de kit e instala la skill y el servidor
MCP en los agentes que encuentre: **Claude Code, opencode, Codex y Gemini CLI**.

Si ya usabas bita, `atl site import --from-bita` copia sus sitios y tokens.

## Sitios

```sh
atl site ls
atl site add https://acme.atlassian.net --email yo@acme.com --name acme
atl site default acme
atl site test acme
atl site rm acme
```

Todos los comandos y todas las herramientas MCP aceptan `--site <nombre|url>`
(`site` en MCP). Sin él se usa el sitio por defecto.

Para CI, sin configuración: `ATL_SITE_URL`, `ATL_EMAIL` y `ATL_TOKEN`.

| Sistema | Dónde queda el token |
|---|---|
| macOS | Llavero |
| Windows | Administrador de credenciales |
| Linux | Secret Service; si no hay, archivo `0600` |

## CLI

```sh
atl jira issue get PP-123
atl jira search "project = PP AND status != Done" --limit 20
atl jira issue create --project PP --type Story --summary "Login con SSO" --description @historia.md --estimate 3h
atl jira issue create-many --project PP --issues @plan.json
atl jira issue transition PP-123 done --comment "Listo en develop"
atl jira worklog add PP-123 --started 2026-10-10T09:00:00-06:00 --time-spent "1h 30m"
atl jira comment add PP-123 --body @-

atl confluence page get 123456
atl confluence page upsert DOC "Despliegue" --body @despliegue.md
atl confluence search 'space = DOC AND title ~ "deploy"'
atl confluence attach 123456 ./diagrama.png

atl api search "create version"
atl api describe jira.createVersion
atl api call jira.createVersion --args '{"body":{"name":"1.4.0","projectId":10000}}'
```

- Cualquier valor de texto acepta `@archivo`, y `@-` lo lee de stdin.
- Las listas van separadas por comas o como JSON.
- `atl <comando> --help` lista sus opciones; `atl help` lista todos.

`plan.json` para crear una jerarquía en una llamada:

```json
[
  { "ref": "epic", "type": "Epic", "summary": "Pagos con CoDi" },
  { "ref": "s1", "parentRef": "epic", "type": "Story", "summary": "Cobro", "estimate": "1d" },
  { "parentRef": "s1", "type": "Subtask", "summary": "Webhook", "estimate": "3h" }
]
```

## Servidor MCP

```sh
atl mcp                       # stdio: lo lanza el agente
atl mcp serve                 # HTTP en http://127.0.0.1:7781/mcp, varios clientes
atl mcp token                 # token Bearer del servidor HTTP
```

| Opción | Qué hace |
|---|---|
| `--read-only` | Solo expone herramientas de lectura. |
| `--all-operations` | Expone además cada operación REST como herramienta propia (`op_jira_createVersion`, …). Por defecto se llega a ellas con `api_search` → `api_describe` → `api_call`, para no llenar el contexto del agente con mil herramientas. |
| `--port`, `--host` | Dónde escucha el HTTP. Fuera de localhost exige token. |

Para que todos los agentes compartan un solo servidor HTTP:
`atl setup --mcp http` y después `atl mcp serve`.

### Herramientas

- **Jira**: `jira_get_issue`, `jira_search`, `jira_create_issue`,
  `jira_create_issues`, `jira_edit_issue`, `jira_delete_issue`, `jira_assign`,
  `jira_transitions`, `jira_transition`, `jira_add_comment`, `jira_comments`,
  `jira_delete_comment`, `jira_add_worklog`, `jira_worklogs`, `jira_attach`,
  `jira_link`, `jira_link_types`, `jira_remote_link`, `jira_create_meta`,
  `jira_projects`, `jira_myself`.
- **Jira Software**: `jira_boards`, `jira_sprints`, `jira_move_to_sprint`.
- **Confluence**: `confluence_get_page`, `confluence_find_page`,
  `confluence_create_page`, `confluence_update_page`, `confluence_upsert_page`,
  `confluence_delete_page`, `confluence_children`, `confluence_descendants`,
  `confluence_search`, `confluence_attach`, `confluence_attachments`,
  `confluence_add_comment`, `confluence_comments`, `confluence_labels`,
  `confluence_add_labels`, `confluence_spaces`.
- **API completa**: `api_search`, `api_describe`, `api_call`, `api_catalog`.
- **Utilidades**: `atl_sites`, `convert_markdown`, `convert_to_markdown`.

## Para otras herramientas

atl se registra en kit con estas capacidades: `jira.issue.read`,
`jira.issue.write`, `jira.worklog.write`, `confluence.page.read`,
`confluence.page.write`, `atlassian.api.call`, `markdown.adf`,
`markdown.storage`, `mcp.stdio`, `mcp.http`, entre otras. Otra herramienta la
usa así, sin depender de atl en su `package.json`:

```ts
import { requireTool, invokeTool } from '@kikedealba/kit'

const atl = await requireTool('atl', 'npm install -g @kikedealba/atl', { capability: 'confluence.page.write' })
const { envelope } = await invokeTool(atl, ['confluence', 'page', 'upsert', 'DOC', 'Título', '--body', '@pagina.md'])
```

## Desarrollo

```sh
pnpm install
pnpm test
pnpm generate   # vuelve a generar src/api/catalog desde los OpenAPI de Atlassian
```
