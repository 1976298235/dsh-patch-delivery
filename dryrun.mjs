/**
 * Local dry-run harness for dsh-mcp-server: fake Cordis context + fake Host
 * services + real node:http server, so the MCP wire layer can be exercised
 * before installing the bundle. ASCII-only on purpose.
 */
import { createServer } from 'node:http'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { apply } from './index.js'

const workA = mkdtempSync(join(tmpdir(), 'dsh-mcp-a-'))
const workB = mkdtempSync(join(tmpdir(), 'dsh-mcp-b-'))
const baseTime = Date.now() - 60_000
let seqCounter = 10

const eventLog = new Map([
  [
    'sess-1',
    [
      { type: 'user/message', seq: 1, time: baseTime, data: { message: { role: 'user', content: [{ type: 'text', text: 'hello dsh' }] } } },
      {
        type: 'assistant/message',
        seq: 2,
        time: baseTime + 1000,
        data: {
          message: {
            role: 'assistant',
            content: [
              { type: 'text', text: 'hi there' },
              { type: 'tool-call', name: 'bash', arguments: '{"command":"ls"}' },
            ],
          },
        },
      },
      { type: 'tool/result', seq: 3, time: baseTime + 2000, data: { message: { role: 'tool', content: [{ type: 'text', text: 'file.txt' }] } } },
    ],
  ],
  ['sess-2', []],
])

const sessionRows = [
  {
    sessionId: 'sess-1',
    updatedAt: baseTime + 3000,
    running: false,
    blank: false,
    cwd: workA,
    projections: { kind: 'cached', asOfSeq: 3, values: { title: 'Demo session' } },
  },
  {
    sessionId: 'sess-2',
    updatedAt: baseTime + 2000,
    running: true,
    blank: false,
    cwd: workB,
    projections: { kind: 'cached', asOfSeq: 0, values: { title: 'Second session' } },
  },
]

const sessionObjects = new Map(sessionRows.map((row) => [row.sessionId, { id: row.sessionId, cwd: row.cwd }]))
const liveAgents = new Map()

const services = {
  sessions: { get: (id) => sessionObjects.get(id) },
  agents: { get: (id) => liveAgents.get(id), list: () => [...liveAgents.values()] },
  sessionController: {
    async list() {
      return { items: sessionRows }
    },
    async inspect(sessionId) {
      if (!sessionObjects.has(sessionId)) throw new Error(`session ${sessionId} not found`)
      return {
        meta: { id: sessionId, cwd: sessionObjects.get(sessionId).cwd, createdAt: baseTime, isSeeded: false },
        inheritedEventCount: 0,
        events: eventLog.get(sessionId) ?? [],
      }
    },
    async resolveAgent(sessionId) {
      if (!sessionObjects.has(sessionId)) return { error: { code: 'session/not-found', message: 'missing' } }
      const agent = { id: sessionId, status: 'idle', session: sessionObjects.get(sessionId) }
      liveAgents.set(sessionId, agent)
      return { agent }
    },
    async prompt(request) {
      const events = eventLog.get(request.sessionId) ?? []
      const text = request.content
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join(' ')
      const turn = ++seqCounter
      events.push({ type: 'turn/start', seq: ++seqCounter, time: Date.now(), data: { turn } })
      events.push({ type: 'user/message', seq: ++seqCounter, time: Date.now(), data: { source: { kind: 'user', rpcId: request.requestId }, content: request.content } })
      events.push({
        type: 'assistant/message',
        seq: ++seqCounter,
        time: Date.now(),
        data: { message: { role: 'assistant', content: [{ type: 'text', text: `echo: ${text || '(attachment only)'}` }] } },
      })
      events.push({ type: 'turn/end', seq: ++seqCounter, time: Date.now(), data: { turn, reason: { kind: 'completed' } } })
      eventLog.set(request.sessionId, events)
      return { accepted: true }
    },
    async create(request) {
      const id = `sess-new-${sessionObjects.size + 1}`
      sessionObjects.set(id, { id, cwd: request.cwd ?? workB })
      eventLog.set(id, [])
      sessionRows.push({ sessionId: id, updatedAt: Date.now(), running: false, blank: true, cwd: request.cwd ?? workB })
      return { sessionId: id }
    },
    async rename(request) {
      return { title: request.title, seq: 99 }
    },
    async fork(request) {
      return { sessionId: `fork-of-${request.sessionId}` }
    },
    cancel() {
      return { accepted: true }
    },
    async selectModel(request) {
      return { selected: { provider: request.provider, model: request.model, reasoningEffort: request.reasoningEffort } }
    },
    async modelCatalog() {
      return {
        default: { provider: 'deepseek', model: 'deepseek-chat' },
        routableProviders: ['deepseek'],
        groups: [
          {
            id: 'deepseek',
            name: 'DeepSeek',
            models: [
              { id: 'deepseek-chat', name: 'DeepSeek Chat' },
              { id: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } },
            ],
          },
        ],
        failures: [],
      }
    },
  },
  workingDirectory: {
    defaultDirectory: workA,
    get: (session) => session.cwd,
    async set(agent, path) {
      agent.session.cwd = path
      return path
    },
  },
  workspaceRegistry: {
    list: () => [{ id: 'ws-1', title: 'Main', path: workA }],
    async create(path, title) {
      return { id: 'ws-new', path, title }
    },
  },
  workspaceController: {
    async create(request) {
      return { id: 'ws-new', path: request.path }
    },
    async archiveSession(request) {
      return { archived: request.sessionId }
    },
  },
  fileUploads: {
    async uploadStream(request) {
      return { receiptId: 'rcpt-1', file: { attachmentId: 'file-1', name: request.name ?? 'x', bytes: 42 } }
    },
    bindPrompt() {
      return { commit() {}, [Symbol.dispose]() {} }
    },
  },
  attachments: {
    async admitPromptContent(parts) {
      return parts.map((part) =>
        part.type === 'image'
          ? { type: 'image', attachment: { attachmentId: 'att-1', mediaType: part.mediaType, bytes: 10, width: 1, height: 1 } }
          : part,
      )
    },
    async admitEncodedFile(input) {
      return { attachmentId: 'file-1', name: input.name, bytes: 42 }
    },
  },
  compaction: {
    async compactNow() {
      return { shadowedSeqs: [1, 2, 3], shadowedTokenCount: 1234, summarySeq: 42 }
    },
  },
  commands: {
    async execute(_agent, line) {
      return { commandId: 'cmd-1', result: { kind: 'success', text: `ran ${line}` } }
    },
  },
  tools: {
    schemas: (scope) => [
      ...(scope ? [{ name: 'session-only', description: 'Scoped tool', parameters: { type: 'object' } }] : []),
      { name: 'bash', description: 'Run a shell command.', parameters: { type: 'object' } },
      { name: 'read', description: 'Read a file.', parameters: { type: 'object' } },
    ],
  },
  deepseekAccount: {
    async getState() {
      return { signedIn: true, accountId: 'acc-1' }
    },
    async getBalance() {
      return { currency: 'CNY', total: 12.5, available: 12.5 }
    },
    async getProfile() {
      return { name: 'Tester' }
    },
  },
}

const routes = []
const listeners = new Map()
let origin = 'http://127.0.0.1:0'

const ctx = {
  get: (name) => services[name],
  on: (name, listener) => {
    const list = listeners.get(name) ?? []
    list.push(listener)
    listeners.set(name, list)
    return () => {}
  },
  effect: (factory) => {
    const dispose = factory()
    return () => dispose?.()
  },
  logger: {
    info: (...args) => console.log('[info]', ...args),
    warn: (...args) => console.error('[warn]', ...args),
  },
  webServer: {
    register: (route) => {
      routes.push(route)
      return () => {}
    },
    getOrigin: () => origin,
  },
}

apply(ctx, { stateDirectory: false, path: '/mcp', exposeApprovals: true, waitTimeoutMs: 5000 })

const server = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname
  const route = routes.find((candidate) => candidate.path === pathname)
  if (!route) {
    res.writeHead(404)
    res.end()
    return
  }
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500)
    res.end(String(error))
  })
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
origin = `http://127.0.0.1:${server.address().port}`
console.log('fake DSH MCP server at', origin + '/mcp')

let sessionId
let failures = 0
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`)
  }
}

const rpc = async (method, params, options = {}) => {
  const response = await fetch(`${origin}${options.path ?? '/mcp'}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const header = response.headers.get('mcp-session-id')
  if (header) sessionId = header
  const text = await response.text()
  let body
  try {
    body = text.length > 0 ? JSON.parse(text) : undefined
  } catch {
    body = text
  }
  return { status: response.status, body }
}

const call = async (name, args = {}) => {
  const result = await rpc('tools/call', { name, arguments: args })
  const payload = result.body?.result
  return { status: result.status, isError: payload?.isError === true, text: payload?.content?.[0]?.text ?? '', data: payload?.structuredContent }
}

console.log('\n1. initialize')
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'dry-run', version: '0' } })
check('protocolVersion echoed', init.body?.result?.protocolVersion === '2025-06-18', init.body)
check('session header issued', Boolean(sessionId))
check('tools capability present', Boolean(init.body?.result?.capabilities?.tools))

console.log('\n2. notifications/initialized')
const note = await rpc('notifications/initialized')
check('notification accepted (202)', note.status === 202, note.status)

console.log('\n3. tools/list')
const list = await rpc('tools/list', {})
const names = (list.body?.result?.tools ?? []).map((tool) => tool.name)
check('tool count is 30', names.length === 30, names.length)
check('core names present', names.includes('dsh_send_text') && names.includes('dsh_get_balance') && names.includes('dsh_answer_approval'), names)
check('every tool has object schema', (list.body?.result?.tools ?? []).every((tool) => tool.inputSchema?.type === 'object'))

console.log('\n4. dsh_list_sessions')
const listed = await call('dsh_list_sessions', {})
check('lists sess-1', listed.text.includes('sess-1'), listed.text)
check('title rendered', listed.text.includes('Demo session'), listed.text)

console.log('\n5. dsh_switch_session + dsh_current_session')
const switched = await call('dsh_switch_session', { session_id: 'sess-1' })
check('switch ok', switched.text.includes('active session set to sess-1'), switched.text)
const current = await call('dsh_current_session')
check('current shows title', current.text.includes('Demo session'), current.text)
check('current shows no model yet', current.text.includes('(no request yet)'), current.text)

console.log('\n6. dsh_read_conversation')
const transcript = await call('dsh_read_conversation', { limit: 10 })
check('user message', transcript.text.includes('hello dsh'), transcript.text)
check('assistant message', transcript.text.includes('hi there'), transcript.text)
check('tool call rendered', transcript.text.includes('bash('), transcript.text)
check('tool result rendered', transcript.text.includes('file.txt'), transcript.text)

console.log('\n7. dsh_send_text (wait=true)')
const sent = await call('dsh_send_text', { text: 'ping', timeout_ms: 4000 })
check('reply returned', sent.text.includes('echo: ping'), sent.text)
check('settled', sent.text.includes('settled'), sent.text)

console.log('\n8. dsh_send_text (wait=false)')
const queued = await call('dsh_send_text', { text: 'fire and forget', wait: false })
check('accepted only', queued.text.includes('accepted (queue)'), queued.text)

console.log('\n9. model tools')
const catalog = await call('dsh_list_models')
check('groups', catalog.text.includes('DeepSeek') && catalog.text.includes('deepseek-reasoner'), catalog.text)
const selected = await call('dsh_set_model', { model: 'deepseek-reasoner', reasoning_effort: 'high' })
check('provider inferred', selected.text.includes('deepseek/deepseek-reasoner'), selected.text)

console.log('\n10. working directory + workspaces')
const cwd = await call('dsh_get_working_directory')
check('cwd read', cwd.text.includes(workA), cwd.text)
const moved = await call('dsh_set_working_directory', { path: workA })
check('cwd set', moved.text.includes(workA), moved.text)
const workspaces = await call('dsh_list_workspaces')
check('workspace list', workspaces.text.includes('ws-1'), workspaces.text)
const created = await call('dsh_create_workspace', { path: workA, title: 'New' })
check('workspace created', created.text.includes('ws-new'), created.text)

console.log('\n11. compact + command')
const compacted = await call('dsh_compact')
check('compact result', compacted.text.includes('3 history items'), compacted.text)
const command = await call('dsh_run_command', { line: '/compact' })
check('command result', command.text.includes('success'), command.text)

console.log('\n12. balance + status + agent tools')
const balance = await call('dsh_get_balance')
check('balance json', balance.text.includes('"total": 12.5'), balance.text)
const status = await call('dsh_get_status')
check('status endpoint', status.text.includes(`${origin}/mcp`), status.text)
const agentTools = await call('dsh_list_tools')
check('agent tools', agentTools.text.includes('bash'), agentTools.text)

console.log('\n12b. dsh_send_file')
const sentFile = await call('dsh_send_file', {
  path: fileURLToPath(new URL('./icon.svg', import.meta.url)),
  text: 'see attachment',
  wait: true,
  timeout_ms: 4000,
})
check('file attached and replied', sentFile.text.includes('attached file icon.svg') && sentFile.text.includes('echo: see attachment'), sentFile.text)

console.log('\n13. session create / rename / fork / cancel')
const createdSession = await call('dsh_create_session', { cwd: workB })
check('created', createdSession.text.includes('created session sess-new-'), createdSession.text)
const renamed = await call('dsh_rename_session', { title: 'Renamed' })
check('renamed', renamed.text.includes('Renamed'), renamed.text)
const forked = await call('dsh_fork_session', { session_id: 'sess-1' })
check('forked', forked.text.includes('fork-of-sess-1'), forked.text)
const cancelled = await call('dsh_cancel', { session_id: 'sess-1' })
check('cancelled', cancelled.text.includes('accepted: true'), cancelled.text)

console.log('\n14. approvals')
const approvalListener = listeners.get('approval/request')?.[0]
check('approval listener registered', typeof approvalListener === 'function')
const approvalPromise = approvalListener({ agent: { id: 'sess-1' }, toolName: 'bash', reason: 'run pytest' }, () => new Promise((resolve) => setTimeout(() => resolve('rejected'), 8000)))
const pending = await call('dsh_list_approvals')
check('pending listed', pending.text.includes('bash') && pending.text.includes('run pytest'), pending.text)
const answered = await call('dsh_answer_approval', { decision: 'allow' })
check('answer accepted', answered.text.includes('approved bash'), answered.text)
const outcome = await approvalPromise
check('outcome allowed-once', outcome === 'allowed-once', outcome)
const empty = await call('dsh_list_approvals')
check('no longer pending', empty.text.includes('No pending approvals'), empty.text)

console.log('\n15. resources')
const resources = await rpc('resources/list', {})
check('session resource', (resources.body?.result?.resources ?? []).some((resource) => resource.uri === 'dsh://session/sess-1'), resources.body)
const read = await rpc('resources/read', { uri: 'dsh://session/sess-1' })
check('resource read', read.body?.result?.contents?.[0]?.text?.includes('hello dsh'), read.body)

console.log('\n16. protocol edges')
const unknown = await rpc('nope/nope', {})
check('method not found', unknown.body?.error?.code === -32601, unknown.body)
const badJson = await fetch(`${origin}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' })
check('parse error 400', badJson.status === 400, badJson.status)
const getProbe = await fetch(`${origin}/mcp`, { headers: { 'mcp-session-id': sessionId } })
check('GET returns 405', getProbe.status === 405, getProbe.status)
const health = await fetch(`${origin}/mcp/health`)
const healthBody = await health.json()
check('health lists tools', healthBody.tools?.length === names.length, healthBody.tools?.length)
const badOrigin = await fetch(`${origin}/mcp`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
})
check('foreign origin rejected', badOrigin.status === 403, badOrigin.status)

console.log('\n17. token mode')
const tokenRoutes = []
const tokenCtx = {
  ...ctx,
  webServer: {
    register: (route) => {
      tokenRoutes.push(route)
      return () => {}
    },
    getOrigin: () => origin,
  },
}
apply(tokenCtx, { stateDirectory: false, path: '/secure', token: 's3cret', exposeApprovals: false })
const secureServer = createServer((req, res) => {
  const pathname = new URL(req.url, 'http://x').pathname
  const route = tokenRoutes.find((candidate) => candidate.path === pathname)
  if (!route) {
    res.writeHead(404)
    res.end()
    return
  }
  Promise.resolve(route.handler(req, res))
})
await new Promise((resolve) => secureServer.listen(0, '127.0.0.1', resolve))
const secureOrigin = `http://127.0.0.1:${secureServer.address().port}`
const noToken = await fetch(`${secureOrigin}/secure`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
})
check('missing token 401', noToken.status === 401, noToken.status)
const withToken = await fetch(`${secureOrigin}/secure`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: 'Bearer s3cret' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
})
const tokenBody = await withToken.json()
check('valid token 200', withToken.status === 200 && Array.isArray(tokenBody.result?.tools), withToken.status)


console.log('\n18. strict validation and fail-closed approval')
for (const args of [{include_tools:'false'}, {unexpected:true}, {limit:1.5}, {limit:0}, {session_id:null}]) {
  const bad = await call('dsh_read_conversation', {session_id:'sess-1', ...args})
  check(`reject invalid arguments ${JSON.stringify(args)}`, bad.isError && bad.data?.error?.code === 'INVALID_ARGUMENT', bad)
}
const blockedApproval = approvalListener({ agent:{id:'sess-1'}, toolName:'bash' }, () => new Promise(() => {}))
const badApproval = await call('dsh_answer_approval', {decision:'alow'})
check('invalid approval does not grant', badApproval.isError && (await call('dsh_list_approvals')).text.includes('bash'), badApproval)
await call('dsh_answer_approval', {decision:'deny'})
check('approval still rejectable', await blockedApproval === 'rejected')

console.log('\n19. concurrent idempotency and structured identifiers')
let createCalls=0
const originalCreate = services.sessionController.create
services.sessionController.create = async (args) => { createCalls++; await new Promise(resolve=>setTimeout(resolve,30)); return originalCreate(args) }
const creates = await Promise.all([0,1].map(()=>call('dsh_create_session', {cwd:workA,switch:false,idempotency_key:'create-once'})))
check('duplicate concurrent create coalesced', createCalls===1 && creates[0].data.session_id===creates[1].data.session_id, creates)
const conflict = await call('dsh_create_session', {cwd:workB,switch:false,idempotency_key:'create-once'})
check('same key different args rejected', conflict.isError && conflict.data?.error?.code==='IDEMPOTENCY_CONFLICT', conflict)
let promptCalls=0
const originalPrompt=services.sessionController.prompt
services.sessionController.prompt=async request=>{promptCalls++; return originalPrompt(request)}
const submissions=await Promise.all([0,1].map(()=>call('dsh_send_text',{session_id:'sess-1',text:'dedup',wait:false,idempotency_key:'send-once'})))
check('duplicate submit sends one prompt', promptCalls===1 && submissions[0].data.task_id===submissions[1].data.task_id, submissions)
const finished=await call('dsh_get_task',{task_id:submissions[0].data.task_id})
check('task correlated to completed Host turn', finished.data?.status==='completed' && finished.data.result.includes('echo: dedup'), finished)
const waited=await call('dsh_wait_task',{task_id:finished.data.task_id,timeout_ms:1000})
check('wait resumes existing task', waited.data.status==='completed' && promptCalls===1, waited)

console.log('\n20. queued, failure, cancellation and uncertain admission')
let pendingRequest
services.sessionController.prompt=async request=>{pendingRequest=request; return {accepted:true}}
const queuedTask=await call('dsh_send_text',{session_id:'sess-1',text:'queued',wait:false})
const queuedStatus=await call('dsh_get_task',{task_id:queuedTask.data.task_id})
check('idle does not complete a queued task', queuedStatus.data.status==='queued',queuedStatus)
const pendingLog=eventLog.get('sess-1')
const turn=++seqCounter
pendingLog.push({type:'turn/start',seq:++seqCounter,data:{turn}},{type:'user/message',seq:++seqCounter,data:{source:{kind:'user',rpcId:pendingRequest.requestId},content:[{type:'text',text:'queued'}]}})
const running=await call('dsh_get_task',{task_id:queuedTask.data.task_id})
check('admitted task running',running.data.status==='running',running)
pendingLog.push({type:'turn/end',seq:++seqCounter,data:{turn,reason:{kind:'error',error:{code:'MOCK_ERROR',message:'test failure'}}}})
const failed=await call('dsh_get_task',{task_id:queuedTask.data.task_id})
check('failed turn not reported completed',failed.data.status==='failed' && failed.data.error.code==='MOCK_ERROR',failed)
const cancelledTask=await call('dsh_send_text',{session_id:'sess-1',text:'cancelled',wait:false})
const cancelledTurn=++seqCounter
pendingLog.push({type:'turn/start',seq:++seqCounter,data:{turn:cancelledTurn}},{type:'user/message',seq:++seqCounter,data:{source:{kind:'user',rpcId:pendingRequest.requestId},content:[]}},{type:'turn/end',seq:++seqCounter,data:{turn:cancelledTurn,reason:{kind:'aborted',reason:{kind:'user'}}}})
check('cancelled turn distinguished',(await call('dsh_get_task',{task_id:cancelledTask.data.task_id})).data.status==='cancelled')
let uncertainCalls=0
services.sessionController.prompt=async()=>{uncertainCalls++;throw new Error('transport failed after admission')}
const uncertain=await call('dsh_send_text',{session_id:'sess-1',text:'uncertain',wait:false,idempotency_key:'uncertain'})
const uncertainRetry=await call('dsh_send_text',{session_id:'sess-1',text:'uncertain',wait:false,idempotency_key:'uncertain'})
check('uncertain submission exposes recovery handle and is not repeated',uncertain.isError && uncertain.data.task.status==='submission_unknown' && uncertainRetry.isError && uncertainCalls===1,uncertain)
services.sessionController.prompt=originalPrompt

console.log('\n21. bounded incremental logs and session-scoped tools')
const longLog=[]
for(let n=1;n<=45;n++) longLog.push({type:'assistant/message',seq:n,time:Date.now(),data:{message:{content:[{type:'text',text:`marker-${n} `+'x'.repeat(3900)}]}}})
eventLog.set('sess-2',longLog)
const tail=await call('dsh_read_conversation',{session_id:'sess-2',limit:45})
check('bounded default tail retains newest reply',tail.text.includes('marker-45') && tail.data.has_earlier,tail.data)
let cursor=0, collected=[],pages=0
do {
 const page=await call('dsh_read_conversation',{session_id:'sess-2',after_seq:cursor,limit:5})
 collected.push(...page.data.events.map(event=>event.seq))
 cursor=page.data.next_cursor;pages++
 if(!page.data.has_more)break
}while(pages<20)
check('cursor pages have no gaps or duplicates',collected.length===45 && new Set(collected).size===45 && cursor===45,{collected,pages})
const userLog=await call('dsh_read_conversation',{session_id:'sess-1',after_seq:0,limit:200})
check('actual Host user content shape rendered',userLog.data.events.some(event=>event.type==='user/message' && event.text==='dedup'))
const scoped=await call('dsh_list_tools',{session_id:'sess-1'})
check('registry uses actual agent scope',scoped.data.scope==='session' && scoped.data.tools.some(tool=>tool.name==='session-only'),scoped)

server.close()
secureServer.close()
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`)
process.exitCode = failures === 0 ? 0 : 1
