/**
 * ③ Grant 管理面（Web 渠道，AR26）。
 *
 * 授予 / 撤销是**管理面动作**，因此这里只产出 HTTP 路由，不注册任何模型工具；
 * 宿主把它挂到 dsh 的 `ctx.webServer`（`{kind, path, handler}` 形状一致），
 * 其它渠道无法触达管理接口（AR26「管理动作只走 Web」）。
 *
 * 三个约束：
 * - **授权由宿主注入**（`authorize`）：本模块不认识 cookie / 一次性 token，
 *   只消费"这次请求的管理员是谁"。缺失即 fail-closed（503）。
 * - **写操作要求 CSRF 头**：`x-dsh-wfxm-admin: 1`，浏览器跨站表单无法伪造。
 * - **审计经 ④ 的 `append`**（AR33，不直读 `audit_log`）；审计失败大声失败，
 *   不假装成功。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { redactDeep } from '@dsh-wfxm/redact'
import { sha256Hex, stableStringify } from '../audit/canonical.js'
import type { AuditFields } from '../audit/events.js'
import {
  GrantError,
  type GrantKind,
  type GrantScope,
  type GrantStore,
} from '../grants/store.js'

/** Mount point, matching dsh `WebServer.register` paths (no trailing slash). */
export const GRANTS_ADMIN_PATH = '/admin/grants'

/** Cross-site guard for mutations; the bundled page sends it, forms cannot. */
export const ADMIN_HEADER = 'x-dsh-wfxm-admin'

const MAX_BODY_BYTES = 64 * 1024

export type AdminAuthResult =
  | { ok: true; actorId: string }
  | { ok: false; status?: 401 | 403; reason?: string }

/** Reads the Web session the host already authenticated; never trusts the body. */
export type AdminAuthorizer = (req: IncomingMessage) => AdminAuthResult

export interface AuditSink {
  append(fields: AuditFields): unknown
}

export interface GrantsAdminDeps {
  grants: GrantStore
  authorize?: AdminAuthorizer | null
  /** ④ 的 append；缺省只做动作不记审计（宿主应始终注入）。 */
  audit?: AuditSink | null
  /**
   * AR37: current policy version used to stamp grants that omit one. Without
   * it an unversioned grant cannot be re-verified once a policy exists.
   */
  policyVersion?: () => string | number | null
  now?: () => Date
}

export interface AdminRoute {
  kind: 'exact' | 'prefix'
  path: string
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

type JsonObject = Record<string, unknown>

interface HttpError {
  status: number
  code: string
  message: string
  extra?: JsonObject
}

function fail(status: number, code: string, message: string, extra?: JsonObject): HttpError {
  return { status, code, message, ...extra === undefined ? {} : { extra } }
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  if (res.writableEnded) return
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    ...extraHeaders,
  })
  res.end(payload)
}

function sendError(res: ServerResponse, error: HttpError): void {
  sendJson(res, error.status, {
    error: error.code,
    message: error.message,
    ...error.extra ?? {},
  })
}

function methodNotAllowed(res: ServerResponse, allow: string): void {
  sendJson(
    res,
    405,
    { error: 'method-not-allowed', message: `allowed: ${allow}` },
    { allow },
  )
}

async function readBody(
  req: IncomingMessage,
): Promise<{ ok: true; raw: string } | { ok: false; error: HttpError }> {
  const chunks: Buffer[] = []
  let total = 0
  let tooLarge = false
  // Drain even past the limit: an early return would destroy the request stream
  // and the client would see a broken connection instead of a 413.
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string)
    total += buffer.length
    if (total > MAX_BODY_BYTES) tooLarge = true
    if (!tooLarge) chunks.push(buffer)
  }
  if (tooLarge) {
    return {
      ok: false,
      error: fail(413, 'payload-too-large', `request body exceeds ${MAX_BODY_BYTES} bytes`),
    }
  }
  return { ok: true, raw: Buffer.concat(chunks).toString('utf8') }
}

function parseJsonObject(raw: string): JsonObject | null {
  if (raw.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as JsonObject
  } catch {
    return null
  }
}

function stringList(value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) return undefined
  const items = value.map((item) => (typeof item === 'string' ? item.trim() : '')).filter(Boolean)
  return items.length === value.length ? items : undefined
}

function parseScope(value: unknown): GrantScope | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const source = value as JsonObject
  const actions = stringList(source.actions)
  if (actions === undefined || actions.length === 0) return null
  const scope: GrantScope = { actions }
  const domains = stringList(source.domains)
  if (domains !== undefined) scope.domains = domains
  const paths = stringList(source.paths)
  if (paths !== undefined) scope.paths = paths
  return scope
}

function isKind(value: unknown): value is GrantKind {
  return value === 'once' || value === 'session' || value === 'forever'
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof GrantError) {
    if (error.code === 'duplicate-source') return fail(409, 'duplicate-source', error.message)
    if (error.code === 'not-found') return fail(404, 'not-found', error.message)
    return fail(400, 'invalid-input', error.message)
  }
  return fail(500, 'internal-error', 'admin action failed')
}

/** Defense in depth: the page never renders server data, but actions still escape. */
function auditDigest(value: unknown): string {
  // Redact before hashing — the digest is what lands in `audit_log.payload_digest`,
  // so the original plaintext (including any embedded keys in payload strings)
  // must never be part of the hash we store (D19-2 = B, four redact mounts).
  return sha256Hex(stableStringify(redactDeep(value).value))
}

function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8')
  const right = Buffer.from(b, 'utf8')
  return left.length === right.length && timingSafeEqual(left, right)
}

/**
 * v1 管理面授权：宿主环境里的单一运维令牌（`DSH_WFXM_ADMIN_TOKEN`）。
 * 未配置即 401（fail-closed）；宿主若有 Web 会话身份，可改注入自己的
 * `AdminAuthorizer` 替换它，本模块不感知认证方式。
 */
export function createBearerAuthorizer(options: {
  token?: string | null
  actorId?: string
}): AdminAuthorizer {
  const expected = options.token ?? null
  const actorId = options.actorId ?? 'web-admin'
  return (req) => {
    if (expected === null || expected.length === 0) {
      return { ok: false, status: 401, reason: 'admin token is not configured on the server' }
    }
    const header = req.headers.authorization
    const provided = typeof header === 'string' && header.startsWith('Bearer ')
      ? header.slice('Bearer '.length)
      : ''
    if (!constantTimeEqual(provided, expected)) {
      return { ok: false, status: 401, reason: 'invalid admin token' }
    }
    return { ok: true, actorId }
  }
}

export function createGrantsAdminRoutes(deps: GrantsAdminDeps): AdminRoute[] {
  const { grants } = deps
  const authorize = deps.authorize ?? null
  const audit = deps.audit ?? null
  const now = deps.now ?? (() => new Date())

  function admit(req: IncomingMessage, res: ServerResponse): string | null {
    if (typeof authorize !== 'function') {
      sendError(res, fail(503, 'admin-unavailable', 'no authorizer wired for the admin surface'))
      return null
    }
    const result = authorize(req)
    if (!result.ok) {
      sendError(
        res,
        fail(result.status ?? 401, result.status === 403 ? 'forbidden' : 'unauthenticated',
          result.reason ?? 'admin session required'),
      )
      return null
    }
    return result.actorId
  }

  function assertMutation(req: IncomingMessage, res: ServerResponse): boolean {
    if (req.headers[ADMIN_HEADER] !== '1') {
      sendError(res, fail(403, 'csrf', `missing ${ADMIN_HEADER}: 1`))
      return false
    }
    const type = req.headers['content-type'] ?? ''
    if (!type.toLowerCase().startsWith('application/json')) {
      sendError(res, fail(415, 'unsupported-media-type', 'content-type must be application/json'))
      return false
    }
    return true
  }

  function record(
    actorId: string,
    action: string,
    target: string | null,
    payload: unknown,
    res: ServerResponse,
  ): boolean {
    if (audit === null) return true
    try {
      audit.append({
        sessionId: null,
        sessionSeq: null,
        time: now().getTime(),
        actorId,
        action,
        target,
        correlationId: null,
        payloadDigest: auditDigest(payload),
      })
      return true
    } catch {
      sendError(res, fail(500, 'audit-unavailable', 'audit append failed; action is not confirmed'))
      return false
    }
  }

  function listPage(): string {
    return renderGrantsAdminPage()
  }

  async function handleCollection(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // The shell carries no data and doubles as the token form, so it is served
    // before the session check; every JSON read and every mutation is checked.
    if (req.method === 'GET' || req.method === 'HEAD') {
      const accept = String(req.headers.accept ?? '')
      if (accept.includes('text/html')) {
        const html = listPage()
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'x-content-type-options': 'nosniff',
          'content-security-policy':
            "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
        })
        res.end(req.method === 'HEAD' ? undefined : html)
        return
      }
    }

    const admin = admit(req, res)
    if (admin === null) return

    if (req.method === 'GET' || req.method === 'HEAD') {
      const url = new URL(req.url ?? GRANTS_ADMIN_PATH, 'http://localhost')
      const actorId = url.searchParams.get('actorId') ?? undefined
      const rows = grants.list({
        ...actorId === undefined ? {} : { actorId },
        includeRevoked: url.searchParams.get('includeRevoked') === '1',
        includeConsumed: url.searchParams.get('includeConsumed') === '1',
      })
      sendJson(res, 200, { grants: rows, generatedAt: now().toISOString() })
      return
    }

    if (req.method !== 'POST') {
      methodNotAllowed(res, 'GET, HEAD, POST')
      return
    }
    if (!assertMutation(req, res)) return

    const body = await readBody(req)
    if (!body.ok) {
      sendError(res, body.error)
      return
    }
    const parsed = parseJsonObject(body.raw)
    if (parsed === null) {
      sendError(res, fail(400, 'invalid-json', 'body must be a JSON object'))
      return
    }

    const scope = parseScope(parsed.scope)
    if (scope === null) {
      sendError(res, fail(400, 'invalid-input', 'scope.actions must be a non-empty string array'))
      return
    }
    if (parsed.kind !== undefined && !isKind(parsed.kind)) {
      sendError(res, fail(400, 'invalid-input', 'kind must be once / session / forever'))
      return
    }
    if (typeof parsed.actorId !== 'string' || parsed.actorId.trim().length === 0) {
      sendError(res, fail(400, 'invalid-input', 'actorId is required'))
      return
    }
    const expiresAt = parsed.expiresAt
    if (expiresAt !== undefined && expiresAt !== null && typeof expiresAt !== 'string') {
      sendError(res, fail(400, 'invalid-input', 'expiresAt must be an ISO timestamp'))
      return
    }

    try {
      // AR37: stamp the policy version in force when the operator did not name
      // one, so new grants stay re-verifiable after a policy bump.
      const resolvedPolicyVersion = parsed.policyVersion === undefined
        ? deps.policyVersion?.() ?? null
        : parsed.policyVersion
      const grant = grants.create({
        actorId: parsed.actorId.trim(),
        scope,
        ...parsed.kind === undefined ? {} : { kind: parsed.kind as GrantKind },
        ...typeof parsed.sourceApprovalId === 'string'
          ? { sourceApprovalId: parsed.sourceApprovalId }
          : {},
        ...expiresAt === undefined ? {} : { expiresAt: expiresAt as string | null },
        ...parsed.policyVersion === undefined && resolvedPolicyVersion === null
          ? {}
          : { policyVersion: resolvedPolicyVersion as string | number | null },
      })
      if (!record(admin, 'grant.create', grant.id, {
        actorId: grant.actorId,
        scope: grant.scope,
        kind: grant.kind,
        sourceApprovalId: grant.sourceApprovalId,
        expiresAt: grant.expiresAt,
        policyVersion: grant.policyVersion,
      }, res)) return
      sendJson(res, 201, { grant })
    } catch (error) {
      sendError(res, toHttpError(error))
    }
  }

  async function handleMember(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const admin = admit(req, res)
    if (admin === null) return
    if (req.method !== 'POST') {
      methodNotAllowed(res, 'POST')
      return
    }
    if (!assertMutation(req, res)) return

    const url = new URL(req.url ?? GRANTS_ADMIN_PATH, 'http://localhost')
    const rest = url.pathname.slice(`${GRANTS_ADMIN_PATH}/`.length)

    if (rest === 'revoke-all') {
      const body = await readBody(req)
      if (!body.ok) {
        sendError(res, body.error)
        return
      }
      const parsed = parseJsonObject(body.raw)
      if (parsed === null) {
        sendError(res, fail(400, 'invalid-json', 'body must be a JSON object'))
        return
      }
      if (parsed.actorId !== undefined && (typeof parsed.actorId !== 'string' || parsed.actorId.trim() === '')) {
        sendError(res, fail(400, 'invalid-input', 'actorId must be a non-empty string when present'))
        return
      }
      const actorId = typeof parsed.actorId === 'string' ? parsed.actorId.trim() : undefined
      const result = grants.revokeAll(actorId)
      if (!record(admin, 'grant.revoke_all', actorId ?? '*', { actorId: actorId ?? null }, res)) return
      sendJson(res, 200, { revoked: result.revoked, actorId: actorId ?? null })
      return
    }

    const match = /^([^/]+)\/revoke$/.exec(rest)
    if (match === null) {
      sendError(res, fail(404, 'not-found', `unknown admin path ${url.pathname}`))
      return
    }
    const grantId = decodeURIComponent(match[1] as string)
    try {
      const result = grants.revoke(grantId)
      if (!result.ok) {
        sendError(res, fail(404, 'not-found', `grant ${grantId} not found`))
        return
      }
      if (!record(admin, 'grant.revoke', grantId, { grantId }, res)) return
      sendJson(res, 200, { grant: result.grant })
    } catch (error) {
      sendError(res, toHttpError(error))
    }
  }

  return [
    {
      kind: 'exact',
      path: GRANTS_ADMIN_PATH,
      handler: (req, res) => handleCollection(req, res),
    },
    {
      kind: 'prefix',
      path: GRANTS_ADMIN_PATH,
      handler: (req, res) => handleMember(req, res),
    },
  ]
}

/**
 * Self-contained admin page. It only reads/writes its own JSON endpoints and
 * renders every value with `textContent`, so grant data never becomes markup.
 */
export function renderGrantsAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Grant 管理 · dsh-wfxm</title>
<style>
  :root { color-scheme: light dark; --fg:#1f2328; --bg:#fff; --muted:#6b7280; --line:#d0d7de; --accent:#0969da; --danger:#cf222e; }
  @media (prefers-color-scheme: dark) { :root { --fg:#e6edf3; --bg:#0d1117; --muted:#8b949e; --line:#30363d; --accent:#4493f8; --danger:#f85149; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:24px; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; color:var(--fg); background:var(--bg); }
  h1 { font-size:20px; margin:0 0 4px; }
  p.hint { margin:0 0 20px; color:var(--muted); }
  section { border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  h2 { font-size:15px; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:12px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
  input, select { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
  .row { display:flex; gap:8px; align-items:end; flex-wrap:wrap; margin-top:12px; }
  button { padding:7px 14px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  button.danger { border-color:var(--danger); color:var(--danger); }
  table { width:100%; border-collapse:collapse; font-size:13px; }
  th, td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; color:var(--muted); }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:12px; word-break:break-all; }
  .state-live { color:var(--accent); } .state-revoked { color:var(--danger); } .state-consumed { color:var(--muted); }
  #message { min-height:20px; margin-top:12px; color:var(--muted); }
  #message.error { color:var(--danger); }
</style>
</head>
<body>
<h1>Grant 管理</h1>
<p class="hint">③ 授权正本（AR20）。管理面动作仅经 Web 渠道（AR26），每次授予/撤销都会写审计。</p>

<section>
  <h2>管理令牌</h2>
  <div class="row">
    <div style="flex:1"><label for="token">DSH_WFXM_ADMIN_TOKEN</label><input id="token" type="password" autocomplete="off" placeholder="与服务端环境变量一致"></div>
    <button id="saveToken">保存</button>
  </div>
  <p class="hint" style="margin:8px 0 0">令牌只存在本标签页的 sessionStorage，请求以 Authorization: Bearer 发送。</p>
</section>

<section>
  <h2>授予</h2>
  <div class="grid">
    <div><label for="actorId">actorId</label><input id="actorId" placeholder="网关 actor id" autocomplete="off"></div>
    <div><label for="kind">类型</label><select id="kind"><option value="once">本次</option><option value="session">本会话</option><option value="forever">永久</option></select></div>
    <div><label for="actions">动作（逗号分隔）</label><input id="actions" placeholder="task.wake, ssh.exec"></div>
    <div><label for="domains">域（可选）</label><input id="domains" placeholder="A, B"></div>
    <div><label for="paths">路径根（可选）</label><input id="paths" placeholder="/home/ailearn/projects/dsh-wfxm"></div>
    <div><label for="expiresAt">过期时间（可选）</label><input id="expiresAt" type="datetime-local"></div>
    <div><label for="sourceApprovalId">来源审批 id（可选）</label><input id="sourceApprovalId" autocomplete="off"></div>
    <div><label for="policyVersion">策略版本（可选）</label><input id="policyVersion" autocomplete="off"></div>
  </div>
  <div class="row"><button id="grant" class="primary">授予</button></div>
  <div id="message"></div>
</section>

<section>
  <h2>现有授权</h2>
  <div class="row">
    <div><label for="filterActor">按 actor 过滤</label><input id="filterActor" autocomplete="off"></div>
    <div><label for="filterRevoked">包含已撤销</label><select id="filterRevoked"><option value="">否</option><option value="1">是</option></select></div>
    <div><label for="filterConsumed">包含已兑付</label><select id="filterConsumed"><option value="">否</option><option value="1">是</option></select></div>
    <button id="refresh">刷新</button>
    <button id="revokeAll" class="danger">全部撤销</button>
  </div>
  <table>
    <thead><tr><th>状态</th><th>actor</th><th>范围</th><th>类型</th><th>发放</th><th>过期</th><th>id</th><th></th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</section>

<script>
(function () {
  'use strict'
  var HEADER = 'x-dsh-wfxm-admin'
  var rows = document.getElementById('rows')
  var message = document.getElementById('message')

  function say(text, isError) {
    message.textContent = text || ''
    message.className = isError ? 'error' : ''
  }

  function splitList(value) {
    return value.split(',').map(function (item) { return item.trim() }).filter(Boolean)
  }

  function stateOf(grant) {
    if (grant.revokedAt) return { text: '已撤销', cls: 'state-revoked' }
    if (grant.consumedAt) return { text: '已兑付', cls: 'state-consumed' }
    if (grant.expiresAt && Date.parse(grant.expiresAt) <= Date.now()) return { text: '已过期', cls: 'state-consumed' }
    return { text: '生效', cls: 'state-live' }
  }

  function scopeText(scope) {
    var parts = ['动作: ' + (scope.actions || []).join(', ')]
    if (scope.domains && scope.domains.length) parts.push('域: ' + scope.domains.join(', '))
    if (scope.paths && scope.paths.length) parts.push('路径: ' + scope.paths.join(', '))
    return parts.join(' · ')
  }

  function cell(text) {
    var td = document.createElement('td')
    td.textContent = text
    return td
  }

  function render(grants) {
    rows.textContent = ''
    grants.forEach(function (grant) {
      var tr = document.createElement('tr')
      var state = stateOf(grant)
      var tdState = document.createElement('td')
      var span = document.createElement('span')
      span.className = state.cls
      span.textContent = state.text
      tdState.appendChild(span)
      tr.appendChild(tdState)
      tr.appendChild(cell(grant.actorId))
      var tdScope = document.createElement('td')
      var code = document.createElement('code')
      code.textContent = scopeText(grant.scope || {})
      tdScope.appendChild(code)
      tr.appendChild(tdScope)
      tr.appendChild(cell(grant.kind))
      tr.appendChild(cell(grant.grantedAt))
      tr.appendChild(cell(grant.expiresAt || '—'))
      var tdId = document.createElement('td')
      var idCode = document.createElement('code')
      idCode.textContent = grant.id
      tdId.appendChild(idCode)
      tr.appendChild(tdId)
      var tdAction = document.createElement('td')
      if (!grant.revokedAt) {
        var button = document.createElement('button')
        button.className = 'danger'
        button.textContent = '撤销'
        button.addEventListener('click', function () { revoke(grant.id) })
        tdAction.appendChild(button)
      }
      tr.appendChild(tdAction)
      rows.appendChild(tr)
    })
    if (!grants.length) {
      var tr = document.createElement('tr')
      var td = document.createElement('td')
      td.colSpan = 8
      td.textContent = '没有匹配的授权'
      tr.appendChild(td)
      rows.appendChild(tr)
    }
  }

  function query() {
    var params = new URLSearchParams()
    var actor = document.getElementById('filterActor').value.trim()
    if (actor) params.set('actorId', actor)
    if (document.getElementById('filterRevoked').value === '1') params.set('includeRevoked', '1')
    if (document.getElementById('filterConsumed').value === '1') params.set('includeConsumed', '1')
    return fetch('/admin/grants?' + params.toString(), { headers: { accept: 'application/json' } })
      .then(function (response) {
        if (response.status === 401) throw new Error('未授权：请先填写管理令牌')
        if (!response.ok) throw new Error('HTTP ' + response.status)
        return response.json()
      })
      .then(function (data) { render(data.grants || []); say('已刷新 ' + (data.grants || []).length + ' 条') })
      .catch(function (error) { say('读取失败: ' + error.message, true) })
  }

  function grant() {
    var actorId = document.getElementById('actorId').value.trim()
    var actions = splitList(document.getElementById('actions').value)
    if (!actorId || !actions.length) { say('actorId 与动作不能为空', true); return }
    var body = { actorId: actorId, kind: document.getElementById('kind').value, scope: { actions: actions } }
    var domains = splitList(document.getElementById('domains').value)
    if (domains.length) body.scope.domains = domains
    var paths = splitList(document.getElementById('paths').value)
    if (paths.length) body.scope.paths = paths
    var expires = document.getElementById('expiresAt').value
    if (expires) body.expiresAt = new Date(expires).toISOString()
    var source = document.getElementById('sourceApprovalId').value.trim()
    if (source) body.sourceApprovalId = source
    var policy = document.getElementById('policyVersion').value.trim()
    if (policy) body.policyVersion = policy
    fetch('/admin/grants', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }).then(readResult).then(function (data) {
      say('已授予 ' + data.grant.id)
      document.getElementById('actions').value = ''
      document.getElementById('sourceApprovalId').value = ''
      return query()
    }).catch(function (error) { say('授予失败: ' + error.message, true) })
  }

  function revoke(grantId) {
    if (!window.confirm('撤销 ' + grantId + '？')) return
    fetch('/admin/grants/' + encodeURIComponent(grantId) + '/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}'
    }).then(readResult).then(function () { say('已撤销 ' + grantId); return query() })
      .catch(function (error) { say('撤销失败: ' + error.message, true) })
  }

  function revokeAll() {
    var actorId = document.getElementById('filterActor').value.trim()
    var label = actorId ? ('actor ' + actorId) : '全部 actor'
    if (!window.confirm('撤销 ' + label + ' 的所有授权？')) return
    fetch('/admin/grants/revoke-all', {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(actorId ? { actorId: actorId } : {})
    }).then(readResult).then(function (data) {
      say('已撤销 ' + data.revoked + ' 条')
      return query()
    }).catch(function (error) { say('批量撤销失败: ' + error.message, true) })
  }

  function readResult(response) {
    return response.json().catch(function () { return {} }).then(function (data) {
      if (!response.ok) throw new Error(data.message || ('HTTP ' + response.status))
      return data
    })
  }

  // The CSRF header cannot be set by a cross-site HTML form; the bearer token
  // is the v1 admin credential (the shell itself carries no grant data).
  var TOKEN_KEY = 'dsh-wfxm-admin-token'
  var token = ''
  try { token = window.sessionStorage.getItem(TOKEN_KEY) || '' } catch (error) { token = '' }
  document.getElementById('token').value = token

  var nativeFetch = window.fetch.bind(window)
  window.fetch = function (input, init) {
    var options = init || {}
    var method = (options.method || 'GET').toUpperCase()
    var headers = Object.assign({}, options.headers)
    if (method !== 'GET' && method !== 'HEAD') headers['x-dsh-wfxm-admin'] = '1'
    if (token) headers.authorization = 'Bearer ' + token
    options.headers = headers
    return nativeFetch(input, options)
  }

  function saveToken() {
    token = document.getElementById('token').value.trim()
    try { window.sessionStorage.setItem(TOKEN_KEY, token) } catch (error) { /* private mode */ }
    say(token ? '令牌已保存' : '令牌已清空')
    if (token) query()
  }

  document.getElementById('saveToken').addEventListener('click', saveToken)
  document.getElementById('grant').addEventListener('click', grant)
  document.getElementById('refresh').addEventListener('click', query)
  document.getElementById('revokeAll').addEventListener('click', revokeAll)
  if (token) query()
  else say('请先填写管理令牌')
})()
</script>
</body>
</html>`
}
