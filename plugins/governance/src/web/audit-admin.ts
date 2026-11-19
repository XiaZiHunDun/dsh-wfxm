/**
 * ④ 审计查询面（H3，Web 管理面，AR26）。
 *
 * `audit_log` 一直是只写不读：写入有哈希链，但 owner 没有任何查询入口。
 * 这里只产出**只读** HTTP 路由，挂到 dsh `ctx.webServer`，不注册模型工具；
 * 认证沿用 ③ 的 `AdminAuthorizer`（默认 Bearer 令牌，未配置即 401）。
 *
 * 读的是 ④ 的公开模块 API（`query` / `verifyChain`），不在此处拼 SQL（AR33）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AuditQueryInput, AuditStore } from '../audit/store.js'
import type { AdminAuthorizer, AdminRoute } from './grants-admin.js'

export const AUDIT_ADMIN_PATH = '/admin/audit'

const MAX_LIMIT = 500

export interface AuditAdminDeps {
  audit: AuditStore
  authorize?: AdminAuthorizer | null
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(JSON.stringify(body))
}

function sendError(res: ServerResponse, status: number, error: string, message: string): void {
  sendJson(res, status, { error, message })
}

function parseIso(value: string | null): string | undefined | { error: string } {
  if (value === null || value === '') return undefined
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return { error: `invalid timestamp: ${value}` }
  return new Date(parsed).toISOString()
}

function parseQuery(url: URL): AuditQueryInput | { error: string } {
  const limitRaw = url.searchParams.get('limit')
  const beforeRaw = url.searchParams.get('beforeSeq')
  const limit = limitRaw === null || limitRaw === '' ? undefined : Number(limitRaw)
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)) {
    return { error: `limit must be an integer between 1 and ${MAX_LIMIT}` }
  }
  const beforeSeq = beforeRaw === null || beforeRaw === '' ? undefined : Number(beforeRaw)
  if (beforeSeq !== undefined && (!Number.isInteger(beforeSeq) || beforeSeq < 1)) {
    return { error: 'beforeSeq must be a positive integer' }
  }
  const from = parseIso(url.searchParams.get('from'))
  if (typeof from === 'object') return from
  const to = parseIso(url.searchParams.get('to'))
  if (typeof to === 'object') return to
  const actorId = url.searchParams.get('actorId')
  const action = url.searchParams.get('action')
  const target = url.searchParams.get('target')
  return {
    ...actorId === null ? {} : { actorId },
    ...action === null ? {} : { action },
    ...target === null ? {} : { target },
    ...from === undefined ? {} : { from },
    ...to === undefined ? {} : { to },
    ...limit === undefined ? {} : { limit },
    ...beforeSeq === undefined ? {} : { beforeSeq },
  }
}

function renderAuditAdminPage(): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>审计查询 · dsh-wfxm</title>
<style>
  :root { color-scheme: light dark; --line:#d7dbe0; --muted:#68707a; --accent:#2f6feb; --danger:#d64545; }
  body { font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; max-width:1100px; margin:0 auto; padding:32px 20px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  p.hint { margin:0 0 20px; color:var(--muted); }
  section { border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
  h2 { font-size:15px; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:12px; }
  label { display:block; font-size:12px; color:var(--muted); margin-bottom:4px; }
  input { width:100%; padding:6px 8px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; }
  .row { display:flex; gap:8px; align-items:end; flex-wrap:wrap; margin-top:12px; }
  button { padding:7px 14px; border:1px solid var(--line); border-radius:6px; background:transparent; color:inherit; font:inherit; cursor:pointer; }
  button.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { text-align:left; padding:7px 6px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { font-weight:600; color:var(--muted); }
  code { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:11px; word-break:break-all; }
  #summary { min-height:20px; margin-top:12px; color:var(--muted); }
  #summary.error { color:var(--danger); }
</style>
</head>
<body>
<h1>审计查询</h1>
<p class="hint">只读 ④ \`audit_log\`：按 actor / action / target / 时间过滤，支持哈希链校验。管理面仅经 Web 渠道（AR26）。</p>

<section>
  <h2>管理令牌</h2>
  <div class="row">
    <div style="flex:1"><label for="token">DSH_WFXM_ADMIN_TOKEN</label><input id="token" type="password" autocomplete="off" placeholder="与服务端环境变量一致"></div>
    <button id="saveToken">保存</button>
  </div>
  <p class="hint" style="margin:8px 0 0">令牌只存在本标签页的 sessionStorage。</p>
</section>

<section>
  <h2>过滤</h2>
  <div class="grid">
    <div><label for="actorId">actorId</label><input id="actorId" autocomplete="off"></div>
    <div><label for="action">action</label><input id="action" autocomplete="off" placeholder="tool.call"></div>
    <div><label for="target">target</label><input id="target" autocomplete="off"></div>
    <div><label for="from">从（ISO / 本地时间）</label><input id="from" type="datetime-local"></div>
    <div><label for="to">到（不含）</label><input id="to" type="datetime-local"></div>
    <div><label for="limit">每页（1–500）</label><input id="limit" type="number" min="1" max="500" value="100"></div>
  </div>
  <div class="row">
    <button id="search" class="primary">查询</button>
    <button id="verify">校验哈希链</button>
    <button id="older">更早一页</button>
  </div>
  <div id="summary"></div>
  <table>
    <thead><tr><th>seq</th><th>时间</th><th>actor</th><th>action</th><th>target</th><th>correlation</th><th>digest</th><th>hash</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
</section>

<script>
(function () {
  'use strict'
  var tokenInput = document.getElementById('token')
  var summary = document.getElementById('summary')
  var tbody = document.getElementById('rows')
  var nextBefore = null

  function token() { return sessionStorage.getItem('dsh-wfxm-admin-token') || '' }
  function setMessage(text, isError) {
    summary.textContent = text
    summary.className = isError ? 'error' : ''
  }
  function fmt(value) { return value === null || value === undefined ? '-' : String(value) }
  function short(value) { return value === null || value === undefined ? '-' : String(value).slice(0, 14) }

  function cell(row, text, title) {
    var td = document.createElement('td')
    var code = document.createElement('code')
    code.textContent = text
    if (title) code.title = title
    td.appendChild(code)
    row.appendChild(td)
  }

  function authHeaders() {
    var value = token()
    return value ? { authorization: 'Bearer ' + value } : {}
  }

  function request(url) {
    return fetch(url, { headers: Object.assign({ accept: 'application/json' }, authHeaders()) })
      .then(function (response) {
        return response.json().catch(function () { return {} }).then(function (body) {
          if (!response.ok) throw new Error(body.message || body.error || ('HTTP ' + response.status))
          return body
        })
      })
  }

  function render(rows) {
    tbody.textContent = ''
    rows.forEach(function (entry) {
      var tr = document.createElement('tr')
      cell(tr, fmt(entry.seq))
      cell(tr, fmt(entry.ts))
      cell(tr, fmt(entry.actorId))
      cell(tr, fmt(entry.action))
      cell(tr, fmt(entry.target))
      cell(tr, fmt(entry.correlationId))
      cell(tr, short(entry.payloadDigest), entry.payloadDigest)
      cell(tr, short(entry.hash), entry.hash)
      tbody.appendChild(tr)
    })
  }

  function params() {
    var query = new URLSearchParams()
    ;[['actorId','actorId'],['action','action'],['target','target'],['from','from'],['to','to'],['limit','limit']].forEach(function (pair) {
      var value = document.getElementById(pair[0]).value.trim()
      if (value !== '') query.set(pair[1], value)
    })
    if (nextBefore !== null) query.set('beforeSeq', String(nextBefore))
    return query
  }

  function load() {
    setMessage('查询中…', false)
    request('/admin/audit?' + params().toString()).then(function (body) {
      render(body.rows || [])
      nextBefore = body.nextBeforeSeq === null || body.nextBeforeSeq === undefined ? null : body.nextBeforeSeq
      setMessage('共 ' + body.count + ' 条，本页 ' + (body.rows || []).length + ' 条' + (nextBefore === null ? '（已到末尾）' : ''), false)
    }).catch(function (error) { setMessage(error.message, true) })
  }

  function verify() {
    setMessage('校验中…', false)
    request('/admin/audit?verify=1').then(function (body) {
      var chain = body.chain || {}
      setMessage('哈希链 ' + (chain.ok ? '通过' : '断裂') + '，已校验 ' + (chain.checked || 0) + ' 条' + (chain.reason ? '：' + chain.reason : ''), !chain.ok)
    }).catch(function (error) { setMessage(error.message, true) })
  }

  tokenInput.value = token()
  document.getElementById('saveToken').addEventListener('click', function () {
    sessionStorage.setItem('dsh-wfxm-admin-token', tokenInput.value.trim())
    setMessage('令牌已保存到本标签页', false)
  })
  document.getElementById('search').addEventListener('click', function () { nextBefore = null; load() })
  document.getElementById('older').addEventListener('click', load)
  document.getElementById('verify').addEventListener('click', verify)
  load()
})()
</script>
</body>
</html>`
}

export function createAuditAdminRoutes(deps: AuditAdminDeps): AdminRoute[] {
  const { audit } = deps
  const authorize = deps.authorize ?? null

  function admit(req: IncomingMessage, res: ServerResponse): string | null {
    if (typeof authorize !== 'function') {
      sendError(res, 503, 'admin-unavailable', 'no authorizer wired for the admin surface')
      return null
    }
    const result = authorize(req)
    if (!result.ok) {
      sendError(
        res,
        result.status ?? 401,
        result.status === 403 ? 'forbidden' : 'unauthenticated',
        result.reason ?? 'admin session required',
      )
      return null
    }
    return result.actorId
  }

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: 'method-not-allowed', message: 'audit query is read-only' }))
      return
    }
    if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'content-security-policy':
          "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      })
      res.end(renderAuditAdminPage())
      return
    }
    if (admit(req, res) === null) return

    const url = new URL(req.url ?? AUDIT_ADMIN_PATH, 'http://localhost')
    if (url.searchParams.get('verify') === '1') {
      sendJson(res, 200, { chain: audit.verifyChain() })
      return
    }
    const parsed = parseQuery(url)
    if ('error' in parsed) {
      sendError(res, 400, 'invalid-input', parsed.error)
      return
    }
    const page = audit.query(parsed)
    sendJson(res, 200, {
      rows: page.rows,
      count: page.count,
      nextBeforeSeq: page.nextBeforeSeq,
    })
  }

  return [{ kind: 'exact', path: AUDIT_ADMIN_PATH, handler }]
}
