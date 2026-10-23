/**
 * @local/dsh-mcp-server
 *
 * Exposes this DeepSeek Harness as an MCP server on the existing Web carrier.
 *
 * Transport: MCP Streamable HTTP (JSON responses, no server-initiated SSE).
 * Endpoint:  POST <origin>/mcp   (initialize / tools/list / tools/call / resources/*)
 *            GET  <origin>/mcp/health
 *
 * Everything is implemented against Host services only, so the plugin needs no
 * dependencies and works in a profile-linked bundle.
 */

import { randomUUID, timingSafeEqual } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, resolve as resolvePath } from 'node:path'
import { Buffer } from 'node:buffer'
import { homedir } from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { StateFile } from './state-store.js'
import { DeliveryManager } from './delivery.js'

export const name = 'dsh-patch-delivery'
export const inject = ['webServer']

const SERVER_INFO = { name: 'deepseek-harness', title: 'DeepSeek Harness', version: '1.2.0' }
const DEFAULT_PROTOCOL = '2025-06-18'
const SUPPORTED_PROTOCOLS = new Set(['2024-11-05', '2025-03-26', '2025-06-18'])
const MAX_BODY_BYTES = 8 * 1024 * 1024
const MAX_FILE_BYTES = 32 * 1024 * 1024
const IMAGE_MEDIA_TYPES = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
}

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

function clampNumber(value, min, max, fallback) {
  const number = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(number)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(number)))
}

function truncate(text, max) {
  const value = String(text ?? '')
  if (value.length <= max) return value
  return `${value.slice(0, max)}\n… (${value.length - max} more characters)`
}

function sleep(ms, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    if (signal?.aborted) {
      rejectSleep(signal.reason ?? new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolveSleep()
    }, ms)
    function onAbort() {
      clearTimeout(timer)
      rejectSleep(signal.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms)
  const controller = new AbortController()
  setTimeout(() => controller.abort(new Error(`timed out after ${ms}ms`)), ms)
  return controller.signal
}

function service(ctx, serviceName) {
  const value = ctx.get(serviceName)
  if (!value) throw new Error(`Harness service "${serviceName}" is not available in this composition.`)
  return value
}

function optional(ctx, serviceName) {
  return ctx.get(serviceName)
}

function formatTime(time) {
  if (typeof time !== 'number' || !Number.isFinite(time)) return '--:--:--'
  const date = new Date(time)
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

function jsonText(value) {
  return JSON.stringify(value, null, 2)
}

function activeLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale ?? 'en-US'
  } catch {
    return 'en-US'
  }
}

/** The prompt API accepts only `UTC` or an IANA Area/Location name. */
function activeTimeZone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (typeof zone === 'string' && (zone === 'UTC' || /^[A-Za-z]+(?:\/[A-Za-z0-9_+\-]+)+$/.test(zone))) return zone
  } catch {
    /* fall through */
  }
  return 'UTC'
}

/** Render one message's content blocks defensively (the wire shape may evolve). */
function renderBlocks(content) {
  if (typeof content === 'string') return content
  if (!content || typeof content !== 'object') return ''
  if (!Array.isArray(content)) {
    if (content.type === 'text' && typeof content.text === 'string') return content.text
    return ''
  }
  const parts = []
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    switch (block.type) {
      case 'text':
        if (typeof block.text === 'string' && block.text.length > 0) parts.push(block.text)
        break
      case 'tool-call':
        parts.push(`→ ${block.name}(${truncate(block.arguments ?? '', 600)})`)
        break
      case 'image':
        parts.push(`[image ${block.attachment?.mediaType ?? 'unknown'}${block.attachment?.bytes ? `, ${block.attachment.bytes}B` : ''}]`)
        break
      case 'file':
        parts.push(`[file ${block.attachment?.name ?? 'unnamed'}${block.attachment?.bytes ? `, ${block.attachment.bytes}B` : ''}]`)
        break
      case 'tool-addition':
        parts.push(`[tool added: ${block.toolName}]`)
        break
      case 'tool-removal':
        parts.push(`[tool removed: ${block.toolName}]`)
        break
      default:
        break
    }
  }
  return parts.join('\n')
}

function messageText(message) {
  if (!message || typeof message !== 'object') return ''
  return renderBlocks(message.content ?? message.blocks ?? message.parts)
}

function lastSeq(inspection) {
  const events = inspection?.events
  if (!Array.isArray(events) || events.length === 0) return 0
  return events[events.length - 1]?.seq ?? 0
}

function formatTranscript(events, options = {}) {
  const includeTools = options.includeTools !== false
  const perMessageLimit = options.perMessageLimit ?? 4000
  const chunks = []
  let used = 0
  const budget = options.budget ?? 60000
  for (const event of events ?? []) {
    let role
    let text
    if (event.type === 'user/message') {
      role = 'user'
      text = messageText(event.data?.message ?? event.data)
    } else if (event.type === 'assistant/message') {
      role = 'assistant'
      text = messageText(event.data?.message ?? event.data)
    } else if (event.type === 'tool/result' && includeTools) {
      role = event.data?.error ? 'tool (error)' : 'tool (result)'
      text = messageText(event.data?.message ?? event.data)
    } else {
      continue
    }
    const body = truncate(text, perMessageLimit).trim()
    if (body.length === 0) continue
    const chunk = `[${event.seq}] ${role} · ${formatTime(event.time)}\n${body}`
    if (used + chunk.length > budget) {
      chunks.push(`… transcript truncated at ${budget} characters (${events.length} events read) …`)
      break
    }
    chunks.push(chunk)
    used += chunk.length
  }
  return chunks.join('\n\n')
}

function collectAssistantText(events, baselineSeq) {
  const parts = []
  for (const event of events ?? []) {
    if (event.seq <= baselineSeq) continue
    if (event.type !== 'assistant/message') continue
    const text = messageText(event.data?.message ?? event.data).trim()
    if (text.length > 0) parts.push(text)
  }
  return parts.join('\n\n')
}

function summaryTitle(summary) {
  const values = summary?.projections?.values ?? {}
  for (const key of ['title', 'sessionTitle', 'name', 'summary']) {
    const value = values[key]
    if (typeof value === 'string' && value.trim().length > 0) return value.trim()
    if (value && typeof value === 'object') {
      if (typeof value.text === 'string' && value.text.trim()) return value.text.trim()
      if (typeof value.value === 'string' && value.value.trim()) return value.value.trim()
    }
  }
  return undefined
}

function describeModel(selection) {
  if (!selection) return 'unknown'
  const effort = selection.reasoningEffort ? ` (reasoning: ${selection.reasoningEffort})` : ''
  return `${selection.provider}/${selection.model}${effort}`
}

function toolValue(text, data) { return { toolText: text, toolData: data } }

function invalidArgument(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ARGUMENT' })
}

function validateArguments(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalidArgument('arguments must be an object.')
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) throw invalidArgument(`Missing required argument: ${key}`)
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = schema.properties?.[key]
    if (!prop) {
      if (schema.additionalProperties === false) throw invalidArgument(`Unknown argument: ${key}`)
      continue
    }
    if (prop.type && (prop.type === 'array' ? !Array.isArray(value) : typeof value !== (prop.type === 'integer' ? 'number' : prop.type) || value === null)) throw invalidArgument(`${key} must be ${prop.type}.`)
    if (prop.type === 'array' && (value.length < (prop.minItems ?? 0) || value.length > (prop.maxItems ?? 100) || value.some(item => typeof item !== prop.items?.type || (typeof item === 'string' && !item.trim())))) throw invalidArgument(`${key} contains invalid items or size.`)
    if (typeof value === 'number' && !Number.isFinite(value)) throw invalidArgument(`${key} must be finite.`)
    if (prop.enum && !prop.enum.includes(value)) throw invalidArgument(`${key} must be one of: ${prop.enum.join(', ')}.`)
    if (typeof value === 'string' && !value.trim()) throw invalidArgument(`${key} must not be blank.`)
    if (prop.maxLength !== undefined && value.length > prop.maxLength) throw invalidArgument(`${key} is too long.`)
    if (prop.minimum !== undefined && value < prop.minimum) throw invalidArgument(`${key} must be >= ${prop.minimum}.`)
    if (prop.maximum !== undefined && value > prop.maximum) throw invalidArgument(`${key} must be <= ${prop.maximum}.`)
    if (prop.type === 'integer' && !Number.isInteger(value)) throw invalidArgument(`${key} must be an integer.`)
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

// ---------------------------------------------------------------------------
// plugin
// ---------------------------------------------------------------------------

/**
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {{ path?: string, token?: string, exposeApprovals?: boolean, waitTimeoutMs?: number }} config
 */
export function apply(ctx, config = {}) {
  const endpointPath = normalizePath(config.path ?? '/mcp')
  const token = typeof config.token === 'string' ? config.token.trim() : ''
  const exposeApprovals = config.exposeApprovals !== false
  const defaultWaitMs = clampNumber(config.waitTimeoutMs ?? 120000, 1000, 900000, 120000)

  /** @type {Map<string, { id: string, activeSessionId?: string, createdAt: number }>} */
  const connections = new Map()
  /** @type {Map<string, { id: string, sessionId: string, toolName: string, reason?: string, createdAt: number, settle: (outcome: string) => void }>} */
  const pendingApprovals = new Map()
  let fallbackConnection

  const tools = new Map()
  const stateDirectory = config.stateDirectory === false ? null : resolvePath(config.stateDirectory ?? resolvePath(homedir(), '.dsh', 'mcp', 'dsh-mcp-server'))
  const runtimeStore = new StateFile(stateDirectory ? resolvePath(stateDirectory, 'runtime.json') : null)
  const receipts = new Map(runtimeStore.data?.receipts ?? [])
  const tasks = new Map(runtimeStore.data?.tasks ?? [])
  const receiptContext = new AsyncLocalStorage()
  const inFlight = new Set()
  const saveRuntime = () => runtimeStore.write({ tasks: [...tasks], receipts: [...receipts].map(([key, { promise, ...record }]) => [key, record]) })
  let closing = false
  let deliveries
  ctx.effect(() => async () => {
    closing = true
    await deliveries?.dispose()
    await Promise.allSettled([...inFlight])
    runtimeStore.dispose()
  }, 'dsh-mcp-server.state')
  const MAX_RECORDS = 500
  const RECEIPT_TTL = 24 * 60 * 60 * 1000
  const idempotentTools = new Set(['dsh_send_text', 'dsh_send_file', 'dsh_create_session', 'dsh_fork_session', 'dsh_create_workspace'])


  const addTool = (definition, run) => {
    if (idempotentTools.has(definition.name)) {
      definition.inputSchema.properties.idempotency_key = { type: 'string', maxLength: 256, description: 'Retry key, scoped to this operation and session. Durable for 24h after completion (capacity 500). Uncertain retries never resubmit automatically.' }
    }
    for (const [key, prop] of Object.entries(definition.inputSchema.properties ?? {})) {
      if (prop.type !== 'number') continue
      prop.type = 'integer'
      prop.minimum = ['at_seq', 'after_seq', 'before_seq'].includes(key) ? 0 : 1
      if (key === 'timeout_ms') { prop.minimum = 1000; prop.maximum = 900000 }
      if (key === 'timeout_ms' && definition.name === 'dsh_wait_task') prop.maximum = 60000
      if (key === 'limit') prop.maximum = definition.name === 'dsh_list_sessions' ? 200 : 2000
    }
    tools.set(definition.name, { definition, run })
  }

  const connectionFor = (sessionIdHeader) => {
    if (!sessionIdHeader) {
      if (!fallbackConnection) fallbackConnection = newConnection('local')
      return fallbackConnection
    }
    const existing = connections.get(sessionIdHeader)
    if (existing) return existing
    const created = newConnection(sessionIdHeader)
    connections.set(sessionIdHeader, created)
    return created
  }

  const newConnection = (id) => ({ id, activeSessionId: undefined, createdAt: Date.now() })

  // -- session helpers ------------------------------------------------------

  const inspectSession = async (sessionId) => {
    const controller = service(ctx, 'sessionController')
    return controller.inspect(sessionId, timeoutSignal(20000))
  }

  const resolveAgent = async (sessionId) => {
    const controller = service(ctx, 'sessionController')
    const result = await controller.resolveAgent(sessionId)
    if (result && result.agent) return result.agent
    const failure = result?.error
    throw new Error(
      `Cannot resolve session ${sessionId}: ${failure?.message ?? failure?.code ?? 'unknown failure'}`,
    )
  }

  const sessionFor = (sessionId) => {
    const sessions = optional(ctx, 'sessions')
    return sessions?.get?.(sessionId)
  }

  const pickSessionId = (args, connection, required = true) => {
    const explicit = typeof args?.session_id === 'string' ? args.session_id.trim() : ''
    if (explicit.length > 0) return explicit
    if (connection?.activeSessionId) return connection.activeSessionId
    if (!required) return undefined
    throw new Error(
      'No session selected. Pass "session_id", or call dsh_switch_session / dsh_create_session first.',
    )
  }

  const listSessionSummaries = async (options = {}) => {
    const controller = service(ctx, 'sessionController')
    const value = await controller.list({}, timeoutSignal(30000))
    let items = Array.isArray(value?.items) ? value.items.slice() : []
    if (options.includeSubagents !== true) items = items.filter((item) => item.origin !== 'subagent')
    const limit = clampNumber(options.limit, 1, 500, 40)
    return items.slice(0, limit)
  }

  const describeSummary = (summary, activeSessionId) => {
    const flags = []
    if (summary.sessionId === activeSessionId) flags.push('active')
    if (summary.running) flags.push('running')
    if (summary.blank) flags.push('blank')
    if (summary.origin === 'subagent') flags.push('subagent')
    const title = summaryTitle(summary) ?? '(untitled)'
    const updated = formatTime(summary.updatedAt)
    const cwd = summary.cwd ? `\n     cwd: ${summary.cwd}` : ''
    return `${summary.sessionId}\n     ${title}${flags.length ? ` [${flags.join(', ')}]` : ''} · updated ${updated}${cwd}`
  }

  const sessionInfoText = async (sessionId) => {
    const inspection = await inspectSession(sessionId)
    const meta = inspection?.meta ?? {}
    const events = Array.isArray(inspection?.events) ? inspection.events : []
    const selectedPreset = events.findLast(event => event.type === 'agent-preset/selected')?.data?.agentPreset
    const agent = optional(ctx, 'agents')?.get?.(sessionId)
    const status = agent?.status
    let model
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event.type === 'request/header' && event.data?.header?.config) {
        model = event.data.header.config
        break
      }
    }
    let workingDirectory = meta.cwd
    if (workingDirectory === undefined) {
      try {
        const wd = optional(ctx, 'workingDirectory')
        const session = sessionFor(sessionId)
        if (wd && session) workingDirectory = wd.get(session)
      } catch {
        workingDirectory = undefined
      }
    }
    let title = '(untitled)'
    try {
      const summaries = await listSessionSummaries({ limit: 500 })
      title = summaryTitle(summaries.find((item) => item.sessionId === sessionId) ?? {}) ?? '(untitled)'
    } catch {
      title = '(unavailable)'
    }
    const lines = [
      `session: ${sessionId}`,
      `title: ${title}`,
      `status: ${status ?? 'not live'}`,
      `cwd: ${workingDirectory ?? '(unknown)'}`,
      `agent preset: ${selectedPreset ?? meta.agentPreset ?? '(default)'}`,
      `parent session: ${meta.parentSession ?? '(none)'}`,
      `created: ${formatTime(meta.createdAt)}`,
      `events: ${events.length}`,
      `last seq: ${lastSeq(inspection)}`,
      `model: ${model ? describeModel(model) : '(no request yet)'}`,
    ]
    return lines.join('\n')
  }

  const transcriptFor = async (sessionId, options) => {
    const inspection = await inspectSession(sessionId)
    const all = Array.isArray(inspection?.events) ? inspection.events : []
    const limit = options.limit ?? 60
    if (options.after_seq !== undefined && options.before_seq !== undefined && options.after_seq >= options.before_seq) {
      throw invalidArgument('after_seq must be smaller than before_seq.')
    }
    const filtered = all.filter((event) => (options.after_seq === undefined || event.seq > options.after_seq) && (options.before_seq === undefined || event.seq < options.before_seq))
    const forward = options.after_seq !== undefined
    const candidates = forward ? filtered.slice(0, limit) : filtered.slice(-limit)
    const selected = []
    let used = 0
    const ordered = forward ? candidates : candidates.slice().reverse()
    for (const event of ordered) {
      const text = event.type === 'tool/result' && options.includeTools === false ? '' : messageText(event.data?.message ?? event.data)
      const row = { seq: event.seq, type: event.type, time: event.time, text: truncate(text, 4000), text_truncated: text.length > 4000,
        turn: event.data?.turn ?? null, request_id: event.data?.source?.rpcId ?? null,
        ...(event.type === 'turn/end' ? { end_reason: event.data?.reason?.kind ?? null } : {}) }
      const bytes = JSON.stringify(row).length
      if (used + bytes > 50000) break
      used += bytes
      selected.push({ event, row })
    }
    if (!forward) selected.reverse()
    const events = selected.map((item) => item.row)
    const next = events.at(-1)?.seq ?? options.after_seq ?? 0
    const data = {
      session_id: sessionId, events, from_seq: events[0]?.seq ?? null, to_seq: events.at(-1)?.seq ?? null,
      next_cursor: next, last_seq: lastSeq(inspection),
      has_more: filtered.some((event) => event.seq > next),
      has_earlier: events.length > 0 && filtered.some((event) => event.seq < events[0].seq),
    }
    const header = `session: ${sessionId}\ncwd: ${inspection?.meta?.cwd ?? '(unknown)'}\ntotal events: ${all.length} · showing ${events.length}\n---`
    const body = formatTranscript(selected.map((item) => item.event), { includeTools: options.includeTools !== false })
    return toolValue(`${header}\n${body || '(no messages in this range)'}`, data)
  }

  const terminalTask = (task) => ['completed', 'failed', 'cancelled'].includes(task.status)

  const beginTask = (sessionId, baselineSeq, requestId) => {
    const now = Date.now()
    for (const [id, task] of tasks) {
      if (terminalTask(task) && now - task.updated_at > RECEIPT_TTL) tasks.delete(id)
    }
    if (tasks.size >= MAX_RECORDS) throw Object.assign(new Error('Task capacity reached.'), { code: 'CAPACITY_EXCEEDED' })
    const task = { task_id: requestId, request_id: requestId, session_id: sessionId, baseline_seq: baselineSeq,
      status: 'submission_unknown', created_at: now, updated_at: now, turn: null, result: '', error: null }
    tasks.set(requestId, task)
    const receipt = receiptContext.getStore()
    if (receipt) receipt.task_id = requestId
    saveRuntime() // Durable before prompt admission; recovery observes, never resubmits.
    return task
  }

  const refreshTask = async (task) => {
    if (terminalTask(task)) return task
    const observation = await inspectSession(task.session_id)
    const events = observation?.events ?? []
    const index = events.findIndex((event) => event.type === 'user/message' && event.data?.source?.rpcId === task.request_id)
    if (index < 0) return task // A queued prompt is not yet part of a turn; idle alone proves nothing.
    const user = events[index]
    const start = events.slice(0, index + 1).findLast((event) => event.type === 'turn/start')
    if (!start) { task.status = 'unknown'; saveRuntime(); return task }
    task.turn = start.data.turn
    const end = events.slice(index + 1).find((event) => event.type === 'turn/end' && event.data?.turn === task.turn)
    const window = events.filter((event) => event.seq > user.seq && (!end || event.seq <= end.seq))
    task.result = truncate(collectAssistantText(window, user.seq), 120000)
    task.shared_turn = events.some((event) => event.seq > start.seq && (!end || event.seq < end.seq) && event.type === 'user/message' && event.data?.source?.kind === 'user' && event.data.source.rpcId !== task.request_id)
    task.status = [...pendingApprovals.values()].some((entry) => entry.sessionId === task.session_id) ? 'waiting_approval' : 'running'
    if (end) {
      task.end_seq = end.seq
      task.end_reason = end.data?.reason ?? null
      const reason = end.data?.reason
      task.status = reason?.kind === 'completed' ? 'completed' : reason?.kind === 'aborted' ? 'cancelled' : 'failed'
      if (task.status === 'failed') task.error = reason?.error ?? { code: reason?.kind ?? 'UNKNOWN_END', message: 'Turn did not complete successfully.' }
    }
    task.updated_at = Date.now()
    saveRuntime()
    return task
  }

  const taskSnapshot = (task) => ({ ...task, next_poll_after_ms: terminalTask(task) ? null : 1000 })
  const waitForTask = async (task, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (true) {
      try { await refreshTask(task) } catch (error) {
        error.code ??= 'OBSERVATION_FAILED'
        error.task = taskSnapshot(task)
        throw error
      }
      if (terminalTask(task) || Date.now() >= deadline) return taskSnapshot(task)
      await sleep(Math.min(500, Math.max(1, deadline - Date.now())))
    }
  }
  const requireTask = (id) => {
    const task = tasks.get(id)
    if (!task) throw Object.assign(new Error('Unknown task_id (terminal records may expire after 24h).'), { code: 'TASK_NOT_FOUND' })
    return task
  }

  // -- tool registrations ---------------------------------------------------

  addTool(
    {
      name: 'dsh_list_sessions',
      title: 'List DSH sessions',
      description:
        'List this Harness\'s sessions, newest activity first, with title, running/blank flags, and cwd. Use the returned session ids with every other dsh_* tool.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maximum sessions to return (1-200, default 30).' },
          include_subagents: { type: 'boolean', description: 'Include subagent child sessions (default false).' },
        },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const items = await listSessionSummaries({
        limit: clampNumber(args.limit ?? 30, 1, 200, 30),
        includeSubagents: args.include_subagents === true,
      })
      if (items.length === 0) return 'No sessions.'
      const lines = items.map((item) => describeSummary(item, connection.activeSessionId))
      return `sessions (${items.length}):\n\n${lines.join('\n\n')}`
    },
  )

  addTool(
    {
      name: 'dsh_switch_session',
      title: 'Switch active DSH session',
      description:
        'Make one session the active target of this MCP connection, so later tools may omit session_id. Returns the session summary.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Durable session id.' } },
        required: ['session_id'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection, false)
      if (!sessionId) throw new Error('session_id is required.')
      await inspectSession(sessionId)
      connection.activeSessionId = sessionId
      return `active session set to ${sessionId}\n\n${await sessionInfoText(sessionId)}`
    },
  )

  addTool(
    {
      name: 'dsh_current_session',
      title: 'Show active DSH session',
      description: 'Show which session this MCP connection currently targets, plus its live details.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_args, connection) => {
      if (!connection.activeSessionId) {
        return 'No active session. Call dsh_list_sessions and then dsh_switch_session, or dsh_create_session.'
      }
      return sessionInfoText(connection.activeSessionId)
    },
  )

  addTool(
    {
      name: 'dsh_create_session',
      title: 'Create a DSH session',
      description:
        'Create a new Harness session, optionally in a given cwd/workspace and with an agent preset, and make it active.',
      inputSchema: {
        type: 'object',
        properties: {
          cwd: { type: 'string', description: 'Absolute working directory for the new session.' },
          workspace_id: { type: 'string', description: 'Existing workspace id to place the session in.' },
          agent_preset: { type: 'string', description: 'Agent preset id (see dsh_list_presets is not provided; omit for the default).' },
          switch: { type: 'boolean', description: 'Make it the active session (default true).' },
        },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const controller = service(ctx, 'sessionController')
      const request = {}
      if (typeof args.cwd === 'string' && args.cwd.trim()) request.cwd = args.cwd.trim()
      if (typeof args.workspace_id === 'string' && args.workspace_id.trim()) request.workspaceId = args.workspace_id.trim()
      if (typeof args.agent_preset === 'string' && args.agent_preset.trim()) request.agentPreset = args.agent_preset.trim()
      const value = await controller.create(request)
      const sessionId = value?.sessionId
      if (args.switch !== false) connection.activeSessionId = sessionId
      return toolValue(`created session ${sessionId}${value?.agentPreset ? ` (preset ${value.agentPreset})` : ''}\n\n${await sessionInfoText(sessionId)}`, { session_id: sessionId, agent_preset: value?.agentPreset ?? null })
    },
  )

  addTool(
    {
      name: 'dsh_session_info',
      title: 'Describe a DSH session',
      description:
        'Read metadata for one session without activating it: cwd, running state, agent preset, event count, and the model of its last request.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Defaults to the active session.' } },
        additionalProperties: false,
      },
    },
    async (args, connection) => sessionInfoText(pickSessionId(args, connection)),
  )

  addTool(
    {
      name: 'dsh_read_conversation',
      title: 'Read a DSH conversation',
      description:
        'Read the tail of one session\'s conversation: user messages, assistant replies, and (optionally) tool results, oldest to newest.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Defaults to the active session.' },
          limit: { type: 'number', description: 'How many final log events to inspect (default 60, max 2000).' },
          include_tools: { type: 'boolean', description: 'Include tool results (default true).' },
          after_seq: { type: 'number', description: 'Return events strictly after this cursor, in ascending order.' },
          before_seq: { type: 'number', description: 'Return events strictly before this sequence.' },
        },
        additionalProperties: false,
      },
    },
    async (args, connection) =>
      transcriptFor(pickSessionId(args, connection), {
        limit: args.limit ?? 60,
        includeTools: args.include_tools !== false,
        after_seq: args.after_seq, before_seq: args.before_seq,
      }),
  )

  addTool(
    {
      name: 'dsh_send_text',
      title: 'Send text to DSH',
      description:
        'Send one user message to a session. With wait=true (default) it blocks until the turn settles and returns the assistant reply; set wait=false to acknowledge the prompt only.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message text.' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
          mode: {
            type: 'string',
            enum: ['queue', 'steer'],
            description: 'queue (default) waits for the current turn; steer interrupts it.',
          },
          wait: { type: 'boolean', description: 'Wait for the turn to finish and return the reply (default true).' },
          timeout_ms: { type: 'number', description: 'Maximum wait in milliseconds.' },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const text = String(args.text ?? '')
      if (!text.trim()) throw invalidArgument('text is required.')
      const sessionId = pickSessionId(args, connection)
      const before = await inspectSession(sessionId)
      const mode = args.mode ?? 'queue'
      const task = beginTask(sessionId, lastSeq(before), randomUUID())
      try {
        await service(ctx, 'sessionController').prompt({ requestId: task.request_id, sessionId, mode,
          content: [{ type: 'text', text }], clientTimeZone: activeTimeZone() }, timeoutSignal(30000))
        task.status = 'queued'; saveRuntime()
      } catch (error) {
        task.status = 'submission_unknown'
        saveRuntime()
        error.code ??= 'SUBMISSION_UNCERTAIN'
        error.task = taskSnapshot(task)
        throw error
      }
      if (args.wait === false) return toolValue(`accepted (${mode}) for session ${sessionId}. Task: ${task.task_id}.`, taskSnapshot(task))
      const outcome = await waitForTask(task, args.timeout_ms ?? defaultWaitMs)
      const settled = terminalTask(outcome) ? 'settled' : 'still running'
      return toolValue(`assistant reply (session ${sessionId}, turn ${settled}, status ${outcome.status}):\n\n${outcome.result || '(no assistant text yet)'}`, outcome)
    },
  )

  addTool(
    {
      name: 'dsh_send_file',
      title: 'Send a file to DSH',
      description:
        'Attach a file from the Harness host filesystem to a prompt. Images are admitted as image parts, everything else as a durable file attachment.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute path on the Harness host (relative paths resolve against the session cwd).' },
          text: { type: 'string', description: 'Optional accompanying message.' },
          name: { type: 'string', description: 'Display name (defaults to the file basename).' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
          mode: { type: 'string', enum: ['queue', 'steer'], description: 'Delivery mode (default queue).' },
          wait: { type: 'boolean', description: 'Wait for the turn and return the reply (default false).' },
          timeout_ms: { type: 'number', description: 'Maximum wait in milliseconds.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const displayName = typeof args.name === 'string' && args.name.trim() ? args.name.trim() : basename(String(args.path))
      let path = String(args.path ?? '').trim()
      if (!path) throw new Error('path is required.')
      if (!isAbsolute(path)) {
        const wd = optional(ctx, 'workingDirectory')
        const session = sessionFor(sessionId)
        const base = wd && session ? wd.get(session) : process.cwd()
        path = resolvePath(base, path)
      }
      const info = await stat(path).catch(() => undefined)
      if (!info || !info.isFile()) throw new Error(`Not a readable regular file: ${path}`)
      if (info.size > MAX_FILE_BYTES) throw new Error(`File is too large (${info.size} bytes, limit ${MAX_FILE_BYTES}).`)
      const bytes = await readFile(path)
      const extension = extname(path).toLowerCase()
      const mediaType = IMAGE_MEDIA_TYPES[extension]
      const requestId = randomUUID()
      const content = []
      if (typeof args.text === 'string' && args.text.trim().length > 0) content.push({ type: 'text', text: args.text })
      let binding
      if (mediaType) {
        // Images travel inline; the Session endpoint admits them against its image limits.
        content.push({ type: 'image', mediaType, data: bytes.toString('base64'), name: displayName })
      } else {
        // Files travel as a staged upload receipt bound to this prompt.
        const uploads = service(ctx, 'fileUploads')
        const agent = await resolveAgent(sessionId)
        const upload = await uploads.uploadStream({
          sessionId,
          name: displayName,
          signal: timeoutSignal(120000),
          data: (async function* streamBytes() {
            yield bytes
          })(),
        })
        binding = uploads.bindPrompt(agent, [upload.receiptId], requestId)
        content.push({ type: 'file', receiptId: upload.receiptId })
      }
      const controller = service(ctx, 'sessionController')
      const before = await inspectSession(sessionId)
      const task = beginTask(sessionId, lastSeq(before), requestId)
      try {
        await controller.prompt(
          {
            requestId,
            sessionId,
            mode: args.mode === 'steer' ? 'steer' : 'queue',
            content,
            clientTimeZone: activeTimeZone(),
          },
          timeoutSignal(30000),
        )
        binding?.commit?.()
        task.status = 'queued'; saveRuntime()
      } catch (error) {
        task.status = 'submission_unknown'
        saveRuntime()
        error.code ??= 'SUBMISSION_UNCERTAIN'
        error.task = taskSnapshot(task)
        try {
          binding?.[Symbol.dispose]?.()
        } catch {
          /* binding already discarded */
        }
        throw error
      }
      const label = mediaType ? `image ${displayName} (${bytes.length}B)` : `file ${displayName} (${bytes.length}B)`
      if (args.wait !== true) return toolValue(`attached ${label} to session ${sessionId}. Task: ${task.task_id}.`, taskSnapshot(task))
      const outcome = await waitForTask(task, args.timeout_ms ?? defaultWaitMs)
      return toolValue(`attached ${label}; turn ${terminalTask(outcome) ? 'settled' : 'still running'}.\n\n${outcome.result || '(no assistant text yet)'}`, outcome)
    },
  )

  addTool({ name: 'dsh_get_task', title: 'Read a submitted task',
    description: 'Read durable task state by task_id. Correlates prompt source rpcId with Host turn/end; idle alone never proves completion. Terminal records can expire after 24h.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false } },
    async (args) => {
      const task = taskSnapshot(await refreshTask(requireTask(args.task_id)))
      return toolValue(`task ${task.task_id}: ${task.status}\n${task.result}`, task)
    })

  addTool({ name: 'dsh_wait_task', title: 'Wait for a submitted task',
    description: 'Bounded wait for a task. Running at timeout is a normal status; call again with the same task_id. This does not resubmit work.',
    annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: { task_id: { type: 'string' }, timeout_ms: { type: 'number', description: 'Wait up to this many milliseconds (default 30000).' } }, required: ['task_id'], additionalProperties: false } },
    async (args) => {
      const task = await waitForTask(requireTask(args.task_id), Math.min(args.timeout_ms ?? 30000, 60000))
      return toolValue(`task ${task.task_id}: ${task.status}\n${task.result}`, task)
    })

  addTool(
    {
      name: 'dsh_cancel',
      title: 'Cancel the running DSH turn',
      description: 'Cancel the active turn of one session without dropping its pending queue.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Defaults to the active session.' } },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const controller = service(ctx, 'sessionController')
      const value = controller.cancel({ sessionId })
      return `cancel requested for ${sessionId} (accepted: ${value?.accepted === true}).`
    },
  )

  addTool(
    {
      name: 'dsh_rename_session',
      title: 'Rename a DSH session',
      description: 'Set the title of one session.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'New title.' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const title = String(args.title ?? '').trim()
      if (!title) throw new Error('title is required.')
      const controller = service(ctx, 'sessionController')
      const value = await controller.rename({ sessionId, title })
      return `renamed ${sessionId} to "${value?.title ?? title}" (seq ${value?.seq ?? '?'}).`
    },
  )

  addTool(
    {
      name: 'dsh_fork_session',
      title: 'Fork a DSH session',
      description: 'Fork one session at an optional event boundary into a new session, and optionally switch to it.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Defaults to the active session.' },
          at_seq: { type: 'number', description: 'Inclusive event sequence to cut at (default: latest completed turn).' },
          switch: { type: 'boolean', description: 'Make the fork active (default true).' },
        },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const controller = service(ctx, 'sessionController')
      const request = { sessionId, allowMigration: true }
      if (typeof args.at_seq === 'number') request.atSeq = args.at_seq
      const value = await controller.fork(request)
      if (args.switch !== false) connection.activeSessionId = value?.sessionId
      return toolValue(`forked ${sessionId} into ${value?.sessionId}${args.switch !== false ? ' (active)' : ''}.`, { session_id: value?.sessionId, parent_session_id: sessionId })
    },
  )

  addTool(
    {
      name: 'dsh_archive_session',
      title: 'Archive a DSH session',
      description: 'Archive one session (hide it from the active list), optionally stopping its running work first.',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: 'Defaults to the active session.' },
          stop_activity: { type: 'boolean', description: 'Stop running work in the session before archiving (default false).' },
        },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const controller = optional(ctx, 'workspaceController')
      if (!controller || typeof controller.archiveSession !== 'function') {
        throw new Error('This composition has no workspace controller to archive sessions.')
      }
      const value = await controller.archiveSession({ sessionId, stopActivity: args.stop_activity === true })
      if (connection.activeSessionId === sessionId) connection.activeSessionId = undefined
      return `archived session ${sessionId}.\nresult: ${jsonText(value ?? null)}`
    },
  )

  addTool(
    {
      name: 'dsh_list_models',
      title: 'List DSH models',
      description: 'List every routable provider/model for this Harness, with reasoning efforts, plus the deployment default.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const controller = service(ctx, 'sessionController')
      const catalog = await controller.modelCatalog()
      const lines = [`default: ${describeModel(catalog?.default)}`, '']
      for (const group of catalog?.groups ?? []) {
        lines.push(`${group.name} (${group.id})`)
        for (const model of group.models ?? []) {
          const efforts = model.reasoning?.efforts?.map((effort) => effort.id).join(', ')
          lines.push(
            `  - ${model.id}${model.name && model.name !== model.id ? ` — ${model.name}` : ''}${efforts ? ` [reasoning: ${efforts}]` : ''}`,
          )
        }
        lines.push('')
      }
      for (const failure of catalog?.failures ?? []) {
        lines.push(`! ${failure.name}: ${failure.message}`)
      }
      return lines.join('\n').trim()
    },
  )

  addTool(
    {
      name: 'dsh_get_model',
      title: 'Show a session\'s model',
      description: 'Report the model used by the last request of one session, falling back to the deployment default.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Defaults to the active session.' } },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const inspection = await inspectSession(sessionId)
      const events = Array.isArray(inspection?.events) ? inspection.events : []
      for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index]
        if (event.type === 'request/header' && event.data?.header?.config) {
          return `session ${sessionId} model: ${describeModel(event.data.header.config)}`
        }
      }
      const catalog = await service(ctx, 'sessionController').modelCatalog()
      return `session ${sessionId} has no model request yet; deployment default: ${describeModel(catalog?.default)}`
    },
  )

  addTool(
    {
      name: 'dsh_set_model',
      title: 'Change a session\'s model',
      description:
        'Select the provider/model (and optional reasoning effort) for one session. The deployment default is updated in the background.',
      inputSchema: {
        type: 'object',
        properties: {
          model: { type: 'string', description: 'Model id, e.g. deepseek-v4.1-flash.' },
          provider: { type: 'string', description: 'Provider id; inferred from the catalog when omitted.' },
          reasoning_effort: { type: 'string', description: 'Reasoning effort id for reasoning models.' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
        },
        required: ['model'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const controller = service(ctx, 'sessionController')
      const model = String(args.model ?? '').trim()
      if (!model) throw new Error('model is required.')
      let provider = typeof args.provider === 'string' ? args.provider.trim() : ''
      if (!provider) {
        const catalog = await controller.modelCatalog()
        for (const group of catalog?.groups ?? []) {
          if ((group.models ?? []).some((entry) => entry.id === model)) {
            provider = group.id
            break
          }
        }
        if (!provider && catalog?.default?.model === model) provider = catalog.default.provider
      }
      if (!provider) throw new Error(`Cannot infer a provider for model "${model}". Call dsh_list_models and pass provider.`)
      const selection = { provider, model }
      if (typeof args.reasoning_effort === 'string' && args.reasoning_effort.trim()) {
        selection.reasoningEffort = args.reasoning_effort.trim()
      }
      const value = await controller.selectModel({ sessionId, ...selection })
      return `session ${sessionId} now uses ${describeModel(value?.selected ?? selection)}`
    },
  )

  addTool(
    {
      name: 'dsh_get_working_directory',
      title: 'Show the working directory',
      description: 'Report the effective working directory of one session.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Defaults to the active session.' } },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const wd = service(ctx, 'workingDirectory')
      const session = sessionFor(sessionId)
      if (session) return `session ${sessionId} cwd: ${wd.get(session)}`
      const agent = await resolveAgent(sessionId)
      const liveSession = agent?.session ?? sessionFor(sessionId)
      if (!liveSession) throw new Error(`Cannot read the working directory of ${sessionId}.`)
      return `session ${sessionId} cwd: ${wd.get(liveSession)}`
    },
  )

  addTool(
    {
      name: 'dsh_set_working_directory',
      title: 'Change the working directory',
      description:
        'Move one session to another working directory (absolute path on the Harness host). This is the session workspace the agent reasons against.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute directory path.' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const wd = service(ctx, 'workingDirectory')
      let path = String(args.path ?? '').trim()
      if (!path) throw new Error('path is required.')
      if (!isAbsolute(path)) {
        const session = sessionFor(sessionId)
        const base = session ? wd.get(session) : wd.defaultDirectory
        path = resolvePath(base, path)
      }
      const info = await stat(path).catch(() => undefined)
      if (!info || !info.isDirectory()) throw new Error(`Not a directory: ${path}`)
      const agent = await resolveAgent(sessionId)
      const next = await wd.set(agent, path)
      return `session ${sessionId} cwd is now ${next}`
    },
  )

  addTool(
    {
      name: 'dsh_list_workspaces',
      title: 'List DSH workspaces',
      description: 'List the durable workspace registry entries of this Harness.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const registry = optional(ctx, 'workspaceRegistry')
      if (!registry) return 'This composition has no workspace registry.'
      const workspaces = registry.list() ?? []
      if (workspaces.length === 0) return 'No workspaces.'
      return workspaces
        .map((workspace) => {
          const title = workspace.title ?? workspace.name ?? '(untitled)'
          return `${workspace.id}\n     ${title}\n     path: ${workspace.path ?? workspace.directory ?? '(unknown)'}`
        })
        .join('\n\n')
    },
  )

  addTool(
    {
      name: 'dsh_create_workspace',
      title: 'Create a DSH workspace',
      description: 'Register a new workspace directory (absolute path) and optionally title it.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Absolute directory path.' },
          title: { type: 'string', description: 'Display title.' },
        },
        required: ['path'],
        additionalProperties: false,
      },
    },
    async (args) => {
      const path = String(args.path ?? '').trim()
      if (!path) throw new Error('path is required.')
      if (!isAbsolute(path)) throw new Error('path must be absolute.')
      const info = await stat(path).catch(() => undefined)
      if (!info || !info.isDirectory()) throw new Error(`Not a directory: ${path}`)
      const title = typeof args.title === 'string' && args.title.trim() ? args.title.trim() : undefined
      const controller = optional(ctx, 'workspaceController')
      const registry = service(ctx, 'workspaceRegistry')
      if (controller) {
        try {
          const value = await controller.create({ path, title })
          return `created workspace ${value?.id ?? value?.workspace?.id ?? '(unknown id)'} at ${path}`
        } catch {
          // fall through to the durable registry directly
        }
      }
      const workspace = await registry.create(path, title)
      return `created workspace ${workspace?.id ?? '(unknown id)'} at ${path}`
    },
  )

  addTool(
    {
      name: 'dsh_compact',
      title: 'Compact a DSH conversation',
      description:
        'Run manual compaction on the selected session: older history is summarized so the context shrinks. The session must be idle.',
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Defaults to the active session.' } },
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const agent = await resolveAgent(sessionId)
      const compaction = optional(ctx, 'compaction')
      if (compaction && typeof compaction.compactNow === 'function') {
        const result = await compaction.compactNow(agent, timeoutSignal(300000))
        if (result === null) return `session ${sessionId}: no compactable history yet.`
        return `session ${sessionId}: compacted ${result.shadowedSeqs?.length ?? 0} history items (~${result.shadowedTokenCount ?? 0} tokens), summary seq ${result.summarySeq ?? '?'}.`
      }
      // Compaction may live in the agent's scope only; the /compact command runs there.
      const commands = service(ctx, 'commands')
      const execution = await commands.execute(agent, '/compact', [], timeoutSignal(300000))
      if (!execution) throw new Error('No /compact command is registered in this composition.')
      const result = execution.result ?? {}
      return `session ${sessionId}: ${result.text ?? result.kind ?? 'compaction requested'}`
    },
  )

  addTool(
    {
      name: 'dsh_run_command',
      title: 'Run a DSH slash command',
      description:
        'Execute a registered human command (for example "/compact" or another command available in this composition) against a session.',
      inputSchema: {
        type: 'object',
        properties: {
          line: { type: 'string', description: 'Command line including the leading slash.' },
          session_id: { type: 'string', description: 'Defaults to the active session.' },
        },
        required: ['line'],
        additionalProperties: false,
      },
    },
    async (args, connection) => {
      const sessionId = pickSessionId(args, connection)
      const line = String(args.line ?? '').trim()
      if (!line) throw new Error('line is required.')
      const commands = service(ctx, 'commands')
      const agent = await resolveAgent(sessionId)
      const execution = await commands.execute(agent, line, [], timeoutSignal(300000))
      if (!execution) return `no command matched "${line}" in session ${sessionId}.`
      const result = execution.result ?? {}
      const text = typeof result.text === 'string' ? result.text : ''
      return `command ${line} -> ${result.kind ?? 'unknown'}${text ? `\n${text}` : ''}`
    },
  )

  addTool(
    {
      name: 'dsh_get_balance',
      title: 'Read the DeepSeek account balance',
      description:
        'Read the signed-in DeepSeek account state and recharge-wallet balance for this Harness. Returns null balance when no account grant is present.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      const account = optional(ctx, 'deepseekAccount')
      if (!account) return 'This composition has no DeepSeek account provider.'
      const client = {
        version: SERVER_INFO.version,
        locale: activeLocale(),
        timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
      }
      const output = { client }
      try {
        output.state = await account.getState()
      } catch (error) {
        output.stateError = error instanceof Error ? error.message : String(error)
      }
      try {
        output.balance = await account.getBalance(client)
      } catch (error) {
        output.balanceError = error instanceof Error ? error.message : String(error)
      }
      try {
        output.profile = await account.getProfile(client)
      } catch (error) {
        output.profileError = error instanceof Error ? error.message : String(error)
      }
      return jsonText(output)
    },
  )

  addTool(
    {
      name: 'dsh_list_approvals',
      title: 'List pending DSH approvals',
      description:
        'List tool-call approval requests from this Harness that are waiting for a decision, with the id needed by dsh_answer_approval.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => {
      if (!exposeApprovals) return 'Approval bridging is disabled by plugin configuration (exposeApprovals: false).'
      if (pendingApprovals.size === 0) return 'No pending approvals.'
      const lines = [...pendingApprovals.values()].map(
        (entry) =>
          `${entry.id}\n     session: ${entry.sessionId}\n     tool: ${entry.toolName}${entry.reason ? `\n     reason: ${entry.reason}` : ''}\n     waiting: ${Math.round((Date.now() - entry.createdAt) / 1000)}s`,
      )
      return `pending approvals (${lines.length}):\n\n${lines.join('\n\n')}`
    },
  )

  addTool(
    {
      name: 'dsh_answer_approval',
      title: 'Answer a DSH approval',
      description:
        'Approve or reject a pending tool-call approval. With one pending request the approval id may be omitted.',
      inputSchema: {
        type: 'object',
        properties: {
          approval_id: { type: 'string', description: 'Approval id from dsh_list_approvals.' },
          decision: { type: 'string', enum: ['allow', 'deny'], description: 'allow grants one run; deny rejects it.' },
        },
        required: ['decision'],
        additionalProperties: false,
      },
    },
    async (args) => {
      if (!exposeApprovals) throw new Error('Approval bridging is disabled by plugin configuration (exposeApprovals: false).')
      if (!['allow', 'deny'].includes(args.decision)) throw invalidArgument('decision must be allow or deny.')
      const decision = args.decision === 'deny' ? 'rejected' : 'allowed-once'
      let entry
      if (typeof args.approval_id === 'string' && args.approval_id.trim()) {
        entry = pendingApprovals.get(args.approval_id.trim())
        if (!entry) throw new Error(`No pending approval with id ${args.approval_id}.`)
      } else {
        if (pendingApprovals.size !== 1) {
          throw new Error(`There are ${pendingApprovals.size} pending approvals; pass approval_id.`)
        }
        entry = [...pendingApprovals.values()][0]
      }
      pendingApprovals.delete(entry.id)
      entry.settle(decision)
      return `${decision === 'allowed-once' ? 'approved' : 'rejected'} ${entry.toolName} for session ${entry.sessionId}.`
    },
  )

  addTool(
    {
      name: 'dsh_get_status',
      title: 'Describe the DSH runtime',
      description: 'Report the MCP endpoint, active session, live agents, running turns, and visible session count.',
      annotations: { readOnlyHint: true },
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    async (_args, connection) => {
      const agents = optional(ctx, 'agents')
      const live = agents?.list?.() ?? []
      let sessionCount = 'unknown'
      try {
        sessionCount = String((await listSessionSummaries({ limit: 500 })).length)
      } catch {
        sessionCount = 'unavailable'
      }
      const lines = [
        `endpoint: ${endpointUrl()}`,
        `protocol: ${DEFAULT_PROTOCOL} (Streamable HTTP, JSON responses)`,
        `tools: ${tools.size}`,
        `active session: ${connection.activeSessionId ?? '(none)'}`,
        `live agents: ${live.length}`,
        ...live.map((agent) => `  - ${agent.id} ${agent.status ?? 'unknown'}`),
        `visible sessions: ${sessionCount}`,
        `pending approvals: ${pendingApprovals.size}`,
      ]
      return lines.join('\n')
    },
  )

  addTool(
    {
      name: 'dsh_list_tools',
      title: 'List tools available to the DSH agent',
      description:
        'List the tools this Harness exposes to its own agent (bash, files, web, subagents, …). Useful before asking DSH to do something specific.',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: { session_id: { type: 'string', description: 'Session whose effective scoped tools to list; omit for global tools only.' }, include_parameters: { type: 'boolean', description: 'Include each parameter schema (default false).' } },
        additionalProperties: false,
      },
    },
    async (args) => {
      const registry = optional(ctx, 'tools')
      if (!registry) return 'This composition exposes no tool registry.'
      const agent = args.session_id ? await resolveAgent(args.session_id) : undefined
      const schemas = registry.schemas(agent) ?? []
      const lines = schemas.map((schema) => {
        const head = `- ${schema.name}: ${schema.description ?? ''}`
        if (args.include_parameters !== true) return head
        return `${head}\n  parameters: ${truncate(JSON.stringify(schema.parameters ?? {}), 1200)}`
      })
      return toolValue(`agent tools (${schemas.length}):\n\n${lines.join('\n')}`, { session_id: args.session_id ?? null, scope: agent ? 'session' : 'global', tools: schemas.map((schema) => ({ name: schema.name, description: schema.description, ...(args.include_parameters ? { parameters: schema.parameters } : {}) })) })
    },
  )

  // -- approval bridge ------------------------------------------------------

  addTool({ name: 'dsh_list_presets', title: 'List DSH work modes',
    description: 'Read actual Host work modes (agent presets), default selection, and activation diagnostics.', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
    async () => {
      const registry = service(ctx, 'agentPresets')
      const presets = (await registry.list()).map(preset => ({ ...preset, isDefault: preset.id === registry.defaultId }))
      return toolValue(jsonText(presets), { presets })
    })
  addTool({ name: 'dsh_select_preset', title: 'Select a blank session work mode',
    description: 'Select a work mode only before the session starts its first turn. The Host enforces this lock. Does not change the global default or approval policy.',
    inputSchema: { type: 'object', properties: { session_id: { type: 'string' }, agent_preset: { type: 'string' } }, required: ['session_id', 'agent_preset'], additionalProperties: false } },
    async args => {
      const agent = await resolveAgent(args.session_id)
      const preset = await service(ctx, 'agentPresets').select(agent, args.agent_preset)
      return toolValue(`session ${args.session_id}: ${preset}`, { session_id: args.session_id, agent_preset: preset })
    })

  if (stateDirectory) {
    const backendCall = async (name, args) => {
      const result = await callTool({ name, arguments: args }, newConnection('delivery'))
      if (result.isError) throw Object.assign(new Error(result.structuredContent.error.message), result.structuredContent.error, { task: result.structuredContent.task })
      return result.structuredContent
    }
    try {
      deliveries = new DeliveryManager({ stateDirectory, recipes: config.verificationRecipes ?? [], backend: {
        createSession: async (cwd, agent_preset) => (await backendCall('dsh_create_session', { cwd, ...(agent_preset ? { agent_preset } : {}), switch: false, idempotency_key: 'delivery-session:' + cwd })).session_id,
        sendText: (session_id, text, idempotency_key) => backendCall('dsh_send_text', { session_id, text, idempotency_key, wait: false }),
        getTask: task_id => backendCall('dsh_get_task', { task_id }),
        lookupTask: async (session_id, key) => {
          const receipt = receipts.get(JSON.stringify(['dsh_send_text', session_id, key]))
          const id = receipt?.task_id ?? receipt?.value?.structuredContent?.task_id ?? receipt?.error?.task?.task_id
          return id && tasks.has(id) ? taskSnapshot(await refreshTask(tasks.get(id))) : null
        },
      } })
    } catch (error) { runtimeStore.dispose(); throw error }
    addTool({ name: 'dsh_start_delivery', title: 'Start isolated code delivery',
      description: 'Create a detached Git worktree and delegate scoped changes. Requires a clean source repository and owner-configured verification recipes. Does not apply changes to the source.',
      inputSchema: { type: 'object', properties: {
        repo: { type: 'string' }, text: { type: 'string' }, idempotency_key: { type: 'string', maxLength: 256 }, agent_preset: { type: 'string', description: 'Optional actual work mode ID from dsh_list_presets.' },
        allowed_paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 100 },
        verification_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 },
      }, required: ['repo', 'text', 'idempotency_key', 'allowed_paths', 'verification_ids'], additionalProperties: false } },
      async args => { const job = await deliveries.start(args); return toolValue(jsonText(job), job) })
    for (const [verb, method, description] of [
      ['get', 'status', 'Observe delivery progress without resubmitting work.'],
      ['collect', 'collect', 'Persist a binary patch, reconstruct clean baseline plus patch, and collect real verification logs. Trusted recipes execute on the host.'],
      ['accept', 'accept', 'Explicitly apply a verified patch to the clean original repository if its baseline still matches. Leaves changes uncommitted.'],
      ['reject', 'reject', 'Reject a settled or unresolved delivery; retains worktrees and evidence. Rejection does not cancel uncertain execution.'],
    ]) addTool({ name: `dsh_${verb}_delivery`, title: `${verb} delivery`, description,
      inputSchema: { type: 'object', properties: { delivery_id: { type: 'string' } }, required: ['delivery_id'], additionalProperties: false } },
      async args => { const job = await deliveries[method](args.delivery_id); return toolValue(jsonText(job), job) })
    addTool({ name: 'dsh_list_verification_recipes', title: 'List verification recipes', description: 'List commands configured by the host owner. Callers can select IDs but cannot supply arbitrary commands.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false } },
      async () => { const recipes = deliveries.catalog(); return toolValue(jsonText(recipes), { recipes }) })
  }

  if (exposeApprovals) {
    ctx.effect(
      () =>
        ctx.on('approval/request', (request, next) => {
          const id = randomUUID()
          /** @type {any} */
          const entry = {
            id,
            sessionId: request?.agent?.id,
            toolName: request?.toolName ?? 'unknown',
            reason: request?.displayReason?.en ?? request?.reason,
            createdAt: Date.now(),
            settle: () => {},
          }
          const external = new Promise((resolveExternal) => {
            entry.settle = resolveExternal
          })
          pendingApprovals.set(id, entry)
          ctx.logger?.info?.(`[dsh-mcp-server] approval requested: ${entry.toolName} in ${entry.sessionId}`)
          return Promise.race([Promise.resolve().then(next), external]).finally(() => {
            pendingApprovals.delete(id)
          })
        }),
      'dsh-mcp-server.approvals',
    )
  }

  // -- HTTP plumbing --------------------------------------------------------

  const endpointUrl = () => {
    try {
      return `${ctx.webServer.getOrigin()}${endpointPath}`
    } catch {
      return endpointPath
    }
  }

  const allowedOrigin = (origin) => {
    if (!origin) return true
    try {
      const host = new URL(origin).hostname
      return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]'
    } catch {
      return false
    }
  }

  const safeEqual = (a, b) => {
    const left = Buffer.from(String(a))
    const right = Buffer.from(String(b))
    if (left.length !== right.length) return false
    return timingSafeEqual(left, right)
  }

  const authorize = (req, url) => {
    if (!allowedOrigin(req.headers.origin)) {
      return { status: 403, message: `Origin ${req.headers.origin} is not allowed (loopback only).` }
    }
    if (token.length === 0) return undefined
    const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : ''
    const bearer = header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : ''
    const query = url.searchParams.get('token') ?? ''
    if (safeEqual(bearer, token) || safeEqual(query, token)) return undefined
    return { status: 401, message: 'Missing or invalid bearer token. Send "Authorization: Bearer <token>".' }
  }

  const readBody = (req) =>
    new Promise((resolveBody, rejectBody) => {
      const chunks = []
      let size = 0
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          rejectBody(new Error(`Request body exceeds ${MAX_BODY_BYTES} bytes.`))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
      req.on('error', rejectBody)
    })

  const sendJson = (res, status, payload, extraHeaders = {}) => {
    const body = payload === undefined ? '' : JSON.stringify(payload)
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...extraHeaders,
    })
    res.end(body)
  }

  const rpcOk = (id, result) => ({ jsonrpc: '2.0', id, result })
  const rpcError = (id, code, message) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } })

  const initializeResult = (params) => {
    const requested = params?.protocolVersion
    const protocolVersion = SUPPORTED_PROTOCOLS.has(requested) ? requested : DEFAULT_PROTOCOL
    return {
      protocolVersion,
      capabilities: {
        tools: { listChanged: false },
        resources: { subscribe: false, listChanged: false },
      },
      serverInfo: SERVER_INFO,
      instructions:
        'This MCP server is a live DeepSeek Harness. Use dsh_list_sessions / dsh_create_session to choose a session, ' +
        'dsh_send_text (wait=true) to talk to its agent, dsh_read_conversation to read history, dsh_set_model and ' +
        'dsh_set_working_directory to reconfigure it, dsh_send_file to attach files, dsh_compact to shrink history, ' +
        'and dsh_list_approvals / dsh_answer_approval to decide pending tool approvals.',
    }
  }

  const callTool = async (params, connection) => {
    const operation = callToolImpl(params, connection)
    inFlight.add(operation)
    try { return await operation } finally { inFlight.delete(operation) }
  }
  const callToolImpl = async (params, connection) => {
    const toolName = params?.name
    const entry = tools.get(toolName)
    if (!entry) return { content: [{ type: 'text', text: `Unknown tool: ${toolName}` }], isError: true, structuredContent: { error: { code: 'UNKNOWN_TOOL', message: `Unknown tool: ${toolName}` } } }
    const execute = async (args) => {
      const value = await entry.run(args, connection)
      const text = value?.toolText ?? (typeof value === 'string' ? value : jsonText(value))
      return { content: [{ type: 'text', text }], ...(value?.toolData ? { structuredContent: value.toolData } : {}) }
    }
    try {
      if (closing) throw Object.assign(new Error('Plugin is shutting down; retry after reload.'), { code: 'SHUTTING_DOWN' })
      const args = params.arguments === undefined ? {} : params.arguments
      validateArguments(entry.definition.inputSchema, args)
      if (!args.idempotency_key || !idempotentTools.has(toolName)) return await execute(args)
      const session = toolName === 'dsh_create_session' || toolName === 'dsh_create_workspace' ? '' : pickSessionId(args, connection)
      const key = JSON.stringify([toolName, session, args.idempotency_key])
      const fingerprintArgs = { ...args, ...(session ? { session_id: session } : {}) }
      delete fingerprintArgs.wait; delete fingerprintArgs.timeout_ms
      const fingerprint = JSON.stringify(canonical(fingerprintArgs))
      const now = Date.now()
      for (const [receiptKey, item] of receipts) {
        if (item.done && now - item.created_at > RECEIPT_TTL) receipts.delete(receiptKey)
      }
      const prior = receipts.get(key)
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw Object.assign(new Error('Idempotency key already used with different arguments.'), { code: 'IDEMPOTENCY_CONFLICT' })
        if (prior.promise) return await prior.promise
        if (prior.done) {
          if (prior.error) throw Object.assign(new Error(prior.error.message), prior.error)
          return prior.value
        }
        if (prior.task_id && tasks.has(prior.task_id)) {
          const task = taskSnapshot(await refreshTask(tasks.get(prior.task_id)))
          return { content: [{ type: 'text', text: `Recovered task ${task.task_id}: ${task.status}. No resubmission.` }], structuredContent: task }
        }
        throw Object.assign(new Error('Previous operation was interrupted before a durable result. Inspect the Host; automatic resubmission is disabled.'), { code: 'OPERATION_UNCERTAIN' })
      }
      if (receipts.size >= MAX_RECORDS) throw Object.assign(new Error('Receipt capacity reached; retry after receipts expire.'), { code: 'CAPACITY_EXCEEDED' })
      const receipt = { fingerprint, created_at: now, done: false }
      // Defer execution until the receipt has been registered to coalesce concurrent retries.
      receipts.set(key, receipt)
      saveRuntime()
      receipt.promise = Promise.resolve().then(() => receiptContext.run(receipt, () => execute(args))).then(value => {
        receipt.value = value; receipt.done = true; saveRuntime(); return value
      }, error => {
        receipt.error = { code: error.code ?? 'TOOL_ERROR', message: error.message, ...(error.task ? { task: error.task } : {}) }
        receipt.done = true; saveRuntime(); throw error
      })
      return await receipt.promise
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger?.warn?.(`[dsh-mcp-server] ${toolName} failed: ${message}`)
      return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true, structuredContent: { error: { code: error.code ?? 'TOOL_ERROR', message }, ...(error.task ? { task: error.task } : {}), ...(error.delivery ? { delivery: error.delivery } : {}) } }
    }
  }

  const listResources = async () => {
    const items = await listSessionSummaries({ limit: 50 }).catch(() => [])
    return items.map((item) => ({
      uri: `dsh://session/${encodeURIComponent(item.sessionId)}`,
      name: summaryTitle(item) ?? `session ${String(item.sessionId).slice(0, 8)}`,
      description: item.cwd ?? '',
      mimeType: 'text/markdown',
    }))
  }

  const readResource = async (params) => {
    const uri = String(params?.uri ?? '')
    const match = /^dsh:\/\/session\/(.+)$/.exec(uri)
    if (!match) throw new Error(`Unsupported resource URI: ${uri}`)
    const sessionId = decodeURIComponent(match[1])
    const transcript = await transcriptFor(sessionId, { limit: 200, includeTools: true })
    const text = transcript.toolText
    return { contents: [{ uri, mimeType: 'text/markdown', text }] }
  }

  const dispatch = async (message, connection) => {
    if (!message || typeof message !== 'object' || Array.isArray(message)) {
      return rpcError(null, -32600, 'Invalid Request')
    }
    const { id, method, params } = message
    const isNotification = id === undefined || id === null
    if (message.jsonrpc !== undefined && message.jsonrpc !== '2.0') {
      return isNotification ? undefined : rpcError(id, -32600, 'Invalid Request: jsonrpc must be "2.0".')
    }
    if (typeof method !== 'string') {
      return isNotification ? undefined : rpcError(id, -32600, 'Invalid Request: missing method.')
    }
    try {
      switch (method) {
        case 'initialize':
          return rpcOk(id, initializeResult(params))
        case 'ping':
          return isNotification ? undefined : rpcOk(id, {})
        case 'tools/list':
          return rpcOk(id, { tools: [...tools.values()].map((entry) => entry.definition) })
        case 'tools/call':
          return rpcOk(id, await callTool(params, connection))
        case 'resources/list':
          return rpcOk(id, { resources: await listResources() })
        case 'resources/read':
          return rpcOk(id, await readResource(params))
        case 'resources/templates/list':
          return rpcOk(id, { resourceTemplates: [] })
        case 'prompts/list':
          return rpcOk(id, { prompts: [] })
        case 'logging/setLevel':
          return isNotification ? undefined : rpcOk(id, {})
        default:
          if (method.startsWith('notifications/')) return undefined
          return isNotification ? undefined : rpcError(id, -32601, `Method not found: ${method}`)
      }
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      return isNotification ? undefined : rpcError(id, -32603, text)
    }
  }

  const handleMcp = async (req, res) => {
    const url = new URL(req.url ?? endpointPath, 'http://127.0.0.1')
    const rejection = authorize(req, url)
    if (rejection) {
      sendJson(res, rejection.status, rpcError(null, -32001, rejection.message))
      return
    }
    const method = req.method ?? 'GET'
    if (method === 'OPTIONS') {
      res.writeHead(204, {
        allow: 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-methods': 'POST, GET, DELETE, OPTIONS',
        'access-control-allow-headers': 'content-type, authorization, mcp-session-id, accept, mcp-protocol-version',
        'access-control-allow-origin': 'http://127.0.0.1',
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (method === 'GET') {
      sendJson(
        res,
        405,
        rpcError(null, -32000, 'This MCP server answers JSON on POST and does not offer a standalone SSE stream.'),
        { allow: 'POST, DELETE, OPTIONS' },
      )
      return
    }
    if (method === 'DELETE') {
      const sessionIdHeader = req.headers['mcp-session-id']
      const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader
      if (sessionId) connections.delete(sessionId)
      res.writeHead(204, { 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (method !== 'POST') {
      sendJson(res, 405, rpcError(null, -32000, `Method ${method} is not supported.`), { allow: 'POST, DELETE, OPTIONS' })
      return
    }

    let raw
    try {
      raw = await readBody(req)
    } catch (error) {
      sendJson(res, 413, rpcError(null, -32700, error.message))
      return
    }
    let payload
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      sendJson(res, 400, rpcError(null, -32700, `Parse error: ${error.message}`))
      return
    }

    const headerValue = req.headers['mcp-session-id']
    const providedSessionId = Array.isArray(headerValue) ? headerValue[0] : headerValue
    const messages = Array.isArray(payload) ? payload : [payload]
    const isInitialize = messages.some((message) => message && message.method === 'initialize')
    let connection
    let sessionId
    if (providedSessionId) {
      connection = connectionFor(providedSessionId)
      sessionId = providedSessionId
    } else if (isInitialize) {
      sessionId = randomUUID()
      connection = newConnection(sessionId)
      connections.set(sessionId, connection)
      fallbackConnection = connection
    } else {
      connection = connectionFor(undefined)
      sessionId = connection.id
    }

    const responses = []
    for (const message of messages) {
      const response = await dispatch(message, connection)
      if (response !== undefined) responses.push(response)
    }

    const headers = { 'mcp-session-id': sessionId }
    if (responses.length === 0) {
      res.writeHead(202, { ...headers, 'cache-control': 'no-store' })
      res.end()
      return
    }
    sendJson(res, 200, Array.isArray(payload) ? responses : responses[0], headers)
  }

  const handleHealth = async (_req, res) => {
    let origin = ''
    try {
      origin = ctx.webServer.getOrigin()
    } catch {
      origin = ''
    }
    sendJson(res, 200, {
      ok: true,
      name: SERVER_INFO.name,
      title: SERVER_INFO.title,
      version: SERVER_INFO.version,
      transport: 'streamable-http',
      protocolVersion: DEFAULT_PROTOCOL,
      endpoint: `${origin}${endpointPath}`,
      authenticated: token.length > 0,
      approvals: exposeApprovals,
      tools: [...tools.keys()],
      uptimeSeconds: Math.round(process.uptime()),
    })
  }

  ctx.effect(() => {
    const disposers = [
      ctx.webServer.register({ kind: 'exact', path: endpointPath, handler: handleMcp }),
      ctx.webServer.register({ kind: 'exact', path: `${endpointPath}/health`, handler: handleHealth }),
    ]
    return () => {
      for (const dispose of disposers) {
        try {
          dispose()
        } catch {
          /* already disposed */
        }
      }
    }
  }, 'dsh-mcp-server.routes')

  ctx.logger?.info?.(`[dsh-mcp-server] MCP endpoint ready at ${endpointPath} (${tools.size} tools)`)
}

function normalizePath(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return '/mcp'
  const withLeading = text.startsWith('/') ? text : `/${text}`
  return withLeading.replace(/\/+$/, '') || '/mcp'
}
