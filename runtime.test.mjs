import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises'
import { execFileSync } from 'node:child_process'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { apply } from './index.js'
import { digest } from './state-store.js'

const root = await mkdtemp(join(process.env.DSH_TEST_ROOT ?? tmpdir(), 'runtime-fixtures-'))
let calls = 0, creates = 0
const events = []
const services = {
  sessionController: {
    resolveAgent: async id => ({ agent: { id } }),
    inspect: async () => ({ meta: { cwd: root }, events }),
    prompt: async request => {
      calls++
      events.push({ seq: events.length + 1, type: 'turn/start', data: { turn: calls } })
      events.push({ seq: events.length + 1, type: 'user/message', data: { source: { rpcId: request.requestId } } })
      events.push({ seq: events.length + 1, type: 'assistant/message', data: { content: [{ type: 'text', text: 'actual event result' }] } })
      events.push({ seq: events.length + 1, type: 'turn/end', data: { turn: calls, reason: { kind: 'completed' } } })
    },
    create: async () => { creates++; return { sessionId: 'new-session' } },
  },
  sessions: { get: id => ({ id }) },
  agentPresets: {
    defaultId: 'standard',
    list: async () => [{ id: 'standard', name: 'Standard' }, { id: 'other', name: 'Other' }],
    select: async (agent, preset) => {
      if (agent.id === 'started-session') throw Object.assign(new Error('This session has already started'), { code: 'agent-preset/locked' })
      assert.equal(preset, 'other'); return preset
    },
  },
}
function host(stateDirectory, verificationRecipes = []) {
  const routes = new Map(), disposers = []
  const ctx = { get: name => services[name], effect: factory => { const dispose = factory(); disposers.push(dispose); return dispose },
    webServer: { register: route => { routes.set(route.path, route.handler); return () => routes.delete(route.path) }, getOrigin: () => 'http://127.0.0.1' } }
  apply(ctx, { stateDirectory, verificationRecipes, exposeApprovals: false })
  const rpc = async (method, params) => {
    const req = Readable.from([Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }))])
    Object.assign(req, { method: 'POST', url: '/mcp', headers: { 'content-type': 'application/json' }, socket: { remoteAddress: '127.0.0.1' } })
    let response
    const res = { writeHead() {}, end(body) { response = JSON.parse(body) } }
    await routes.get('/mcp')(req, res)
    return response.result
  }
  return { rpc, call: (name, args) => rpc('tools/call', { name, arguments: args }), dispose: async () => { for (const dispose of disposers.reverse()) await dispose?.() } }
}
async function mutateLedger(stateDirectory, mutate) {
  const path = join(stateDirectory, 'runtime.json'), envelope = JSON.parse(await readFile(path, 'utf8'))
  mutate(envelope.data); envelope.checksum = digest(JSON.stringify(envelope.data)); await writeFile(path, JSON.stringify(envelope))
}

test('MCP reload retains completed receipts and task event correlation', async () => {
  const dir = join(root, 'completed'); let instance = host(dir)
  try {
    const tools = (await instance.rpc('tools/list')).tools
    assert.equal(tools.length, 36); assert.ok(tools.some(tool => tool.name === 'dsh_accept_delivery'))
    const invalid = await instance.call('dsh_start_delivery', { repo: root, text: 'x', idempotency_key: 'x', allowed_paths: 'a', verification_ids: ['test'] })
    assert.equal(invalid.structuredContent.error.code, 'INVALID_ARGUMENT')
    const args = { session_id: 'session', text: 'x', wait: false, idempotency_key: 'persisted' }
    const first = await instance.call('dsh_send_text', args); assert.ok(first.structuredContent.task_id)
    const count = calls
    await instance.dispose(); instance = host(dir)
    const retry = await instance.call('dsh_send_text', args)
    assert.deepEqual(retry, first); assert.equal(calls, count)
    const status = await instance.call('dsh_get_task', { task_id: first.structuredContent.task_id })
    assert.equal(status.structuredContent.status, 'completed'); assert.equal(status.structuredContent.result, 'actual event result')
    const conflict = await instance.call('dsh_send_text', { ...args, text: 'different' })
    assert.equal(conflict.structuredContent.error.code, 'IDEMPOTENCY_CONFLICT')
  } finally { await instance.dispose() }
})

test('interrupted receipt recovers its associated task without prompt resubmission', async () => {
  const dir = join(root, 'pending'); let instance = host(dir)
  const args = { session_id: 'session', text: 'x', wait: false, idempotency_key: 'pending' }
  const first = await instance.call('dsh_send_text', args), count = calls
  await instance.dispose()
  await mutateLedger(dir, data => { const receipt = data.receipts[0][1]; receipt.done = false; delete receipt.value })
  instance = host(dir)
  try {
    const recovered = await instance.call('dsh_send_text', args)
    assert.equal(recovered.structuredContent.task_id, first.structuredContent.task_id)
    assert.equal(recovered.structuredContent.status, 'completed'); assert.equal(calls, count)
  } finally { await instance.dispose() }
})

test('interrupted creation without durable result fails closed after reload', async () => {
  const dir = join(root, 'creation'); let instance = host(dir)
  const args = { cwd: root, switch: false, idempotency_key: 'create' }
  const first = await instance.call('dsh_create_session', args)
  assert.ok(!first.isError); const count = creates
  await instance.dispose()
  await mutateLedger(dir, data => { const receipt = data.receipts[0][1]; receipt.done = false; delete receipt.value })
  instance = host(dir)
  try {
    const result = await instance.call('dsh_create_session', args)
    assert.equal(result.structuredContent.error.code, 'OPERATION_UNCERTAIN'); assert.equal(creates, count)
  } finally { await instance.dispose() }
})

test('all delivery tools work through MCP with the Host adapter and persistent ledger', async () => {
  const repo = join(root, 'delivery-repo'); await mkdir(repo)
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true })
  git('init', '-q'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'user.name', 'Fixture')
  await writeFile(join(repo, 'a.txt'), 'old'); git('add', '.'); git('commit', '-qm', 'baseline')
  const oldCreate = services.sessionController.create, oldPrompt = services.sessionController.prompt
  let worktree
  services.sessionController.create = async args => { worktree = args.cwd; assert.equal(args.agentPreset, 'other'); return oldCreate(args) }
  services.sessionController.prompt = async args => { await writeFile(join(worktree, 'a.txt'), 'delivered'); return oldPrompt(args) }
  const dir = join(root, 'delivery-state'), recipes = [{ id: 'test', executable: process.execPath, args: ['-e', 'console.log("adapter verified")'] }]
  let instance = host(dir, recipes)
  try {
    const catalog = await instance.call('dsh_list_verification_recipes', {})
    assert.equal(catalog.structuredContent.recipes[0].id, 'test')
    const started = await instance.call('dsh_start_delivery', { repo, text: 'edit a.txt', agent_preset: 'other', allowed_paths: ['a.txt'], verification_ids: ['test'], idempotency_key: 'adapter' })
    assert.ok(!started.isError, JSON.stringify(started)); const delivery_id = started.structuredContent.delivery_id
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'old')
    await instance.dispose()
    const ledgerPath = join(dir, 'deliveries.json'), ledger = JSON.parse(await readFile(ledgerPath, 'utf8'))
    ledger.data.jobs[0].task_id = null; ledger.data.jobs[0].phase = 'submission_unknown'
    ledger.checksum = digest(JSON.stringify(ledger.data)); await writeFile(ledgerPath, JSON.stringify(ledger))
    const sentCount = calls
    instance = host(dir, recipes)
    const status = await instance.call('dsh_get_delivery', { delivery_id }); assert.equal(status.structuredContent.phase, 'awaiting_collection')
    assert.equal(status.structuredContent.recovered_submission, true); assert.equal(calls, sentCount)
    const ready = await instance.call('dsh_collect_delivery', { delivery_id }); assert.equal(ready.structuredContent.phase, 'ready_for_review')
    await instance.dispose(); instance = host(dir, recipes)
    const accepted = await instance.call('dsh_accept_delivery', { delivery_id }); assert.equal(accepted.structuredContent.phase, 'accepted')
    assert.equal(await readFile(join(repo, 'a.txt'), 'utf8'), 'delivered')
    const rejected = await instance.call('dsh_reject_delivery', { delivery_id }); assert.equal(rejected.structuredContent.error.code, 'ALREADY_APPLIED')
  } finally { await instance.dispose(); services.sessionController.create = oldCreate; services.sessionController.prompt = oldPrompt }
})

test('preset discovery uses actual Host metadata without changing global default', async () => {
  const instance = host(join(root, 'presets'))
  try {
    const result = await instance.call('dsh_list_presets', {})
    assert.deepEqual(result.structuredContent.presets.map(preset => [preset.id, preset.isDefault]), [['standard', true], ['other', false]])
    assert.equal(services.agentPresets.defaultId, 'standard')
  } finally { await instance.dispose() }
})

test('preset selection delegates to Host, preserving its started-session lock', async () => {
  const instance = host(join(root, 'select-preset'))
  try {
    const selected = await instance.call('dsh_select_preset', { session_id: 'blank', agent_preset: 'other' })
    assert.equal(selected.structuredContent.agent_preset, 'other')
    const locked = await instance.call('dsh_select_preset', { session_id: 'started-session', agent_preset: 'other' })
    assert.equal(locked.structuredContent.error.code, 'agent-preset/locked')
    assert.equal(services.agentPresets.defaultId, 'standard')
  } finally { await instance.dispose() }
})

test('session info reports a selected preset rather than the original creation header', async () => {
  const instance = host(join(root, 'preset-info'))
  events.push({ seq: events.length + 1, type: 'agent-preset/selected', data: { agentPreset: 'other' } })
  try {
    const result = await instance.call('dsh_session_info', { session_id: 'blank' })
    assert.match(result.content[0].text, /agent preset: other/)
  } finally { events.pop(); await instance.dispose() }
})
