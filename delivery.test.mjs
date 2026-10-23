import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, unlink, rmdir, symlink, realpath } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { DeliveryManager } from './delivery.js'
import { StateFile } from './state-store.js'

const fixtures = await mkdtemp(join(process.env.DSH_TEST_ROOT ?? tmpdir(), 'delivery-fixtures-'))
let sequence = 0
const git = (cwd, ...args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-C', cwd, ...args], { encoding: 'utf8', windowsHide: true })
async function fixture(edit, recipeCode = 'console.log("real verification passed")') {
  const root = join(fixtures, String(++sequence)), repo = join(root, 'repo'), stateDirectory = join(root, 'state')
  await mkdir(repo, { recursive: true })
  git(repo, 'init', '-q'); git(repo, 'config', 'user.email', 'fixture@example.invalid'); git(repo, 'config', 'user.name', 'Fixture')
  await writeFile(join(repo, '.gitattributes'), '* -text\n')
  await writeFile(join(repo, 'a.txt'), 'old\n'); await writeFile(join(repo, 'delete.txt'), 'delete\n')
  git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'baseline')
  let cwd, calls = 0
  const backend = { createSession: async path => { cwd = path; return 'session' }, sendText: async () => { calls++; await edit?.(cwd); return { task_id: 'task' } }, getTask: async () => ({ status: 'completed' }) }
  const options = { stateDirectory, backend, recipes: [{ id: 'test', executable: process.execPath, args: ['-e', recipeCode] }] }
  const manager = new DeliveryManager(options)
  const args = { repo, text: 'fixture task', allowed_paths: ['a.txt', 'delete.txt', 'new.bin'], verification_ids: ['test'], idempotency_key: 'same' }
  return { root, repo, manager, options, args, calls: () => calls }
}
const rejects = (promise, code) => assert.rejects(promise, error => error.code === code)

test('state survives restart, enforces a single owner, rejects corruption', async () => {
  const filename = join(fixtures, 'state.json'), store = new StateFile(filename)
  store.write({ retained: 42 }); assert.throws(() => new StateFile(filename), { code: 'STATE_LOCKED' }); store.dispose()
  const restarted = new StateFile(filename); assert.equal(restarted.data.retained, 42); restarted.dispose()
  await writeFile(filename, '{"version":1,"checksum":"bad","data":{}}')
  assert.throws(() => new StateFile(filename), { code: 'STATE_CORRUPT' })
  await writeFile(filename + '.lock', JSON.stringify({ pid: 2147483647, token: 'dead' }))
  await unlink(filename)
  const stale = new StateFile(filename); stale.dispose()
})

test('isolated modifications/additions/deletions/binary, evidence, restart and explicit acceptance', async () => {
  const f = await fixture(async cwd => { await writeFile(join(cwd, 'a.txt'), 'new\n'); await unlink(join(cwd, 'delete.txt')); await writeFile(join(cwd, 'new.bin'), Buffer.from([0, 255, 13, 10, 42])) })
  let manager = f.manager
  try {
    const job = await manager.start(f.args)
    assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'old\n')
    assert.equal(git(f.repo, 'status', '--porcelain'), '')
    assert.equal((await manager.start(f.args)).delivery_id, job.delivery_id); assert.equal(f.calls(), 1)
    await rejects(manager.start({ ...f.args, text: 'different' }), 'IDEMPOTENCY_CONFLICT')
    const ready = await manager.collect(job.delivery_id)
    assert.equal(ready.phase, 'ready_for_review'); assert.equal(ready.manifest.files.length, 3)
    assert.equal(ready.manifest.verification[0].exit_code, 0)
    assert.match(await readFile(ready.manifest.verification[0].log_path, 'utf8'), /real verification passed/)
    const indexBefore = git(f.repo, 'diff', '--cached')
    await manager.dispose(); manager = new DeliveryManager(f.options)
    assert.equal((await manager.status(job.delivery_id)).phase, 'ready_for_review')
    assert.equal((await manager.accept(job.delivery_id)).phase, 'accepted')
    assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'new\n')
    assert.deepEqual(await readFile(join(f.repo, 'new.bin')), Buffer.from([0, 255, 13, 10, 42]))
    await assert.rejects(readFile(join(f.repo, 'delete.txt')), { code: 'ENOENT' })
    assert.equal(git(f.repo, 'diff', '--cached'), indexBefore)
    assert.equal(git(f.repo, 'rev-parse', 'HEAD').trim(), job.baseline_commit)
    assert.equal((await manager.accept(job.delivery_id)).phase, 'accepted')
  } finally { await manager.dispose() }
})

test('dirty source and traversal are refused without overwriting user changes', async () => {
  const f = await fixture()
  try {
    for (const path of ['../x', 'a/../x', '.git/config', 'C:/x', 'a\\b', '/abs', 'a//b']) await rejects(f.manager.start({ ...f.args, allowed_paths: [path] }), 'INVALID_SCOPE')
    await writeFile(join(f.repo, 'mine.txt'), 'user work')
    await rejects(f.manager.start(f.args), 'DIRTY_WORKTREE'); assert.equal(f.calls(), 0)
    assert.equal(await readFile(join(f.repo, 'mine.txt'), 'utf8'), 'user work')
  } finally { await f.manager.dispose() }
})

test('out of scope changes cannot be delivered', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'outside.txt'), 'out'))
  try { const job = await f.manager.start(f.args); await rejects(f.manager.collect(job.delivery_id), 'OUT_OF_SCOPE') }
  finally { await f.manager.dispose() }
})

test('Git symlink modes are rejected even with Windows regular-file checkout', async () => {
  const f = await fixture(async cwd => { await unlink(join(cwd, 'a.txt')); await writeFile(join(cwd, 'a.txt'), 'new target') })
  try {
    const blob = git(f.repo, 'rev-parse', 'HEAD:a.txt').trim()
    git(f.repo, 'config', 'core.symlinks', 'false')
    git(f.repo, 'update-index', '--cacheinfo', `120000,${blob},a.txt`)
    git(f.repo, 'commit', '-qm', 'symlink baseline')
    const job = await f.manager.start(f.args)
    await assert.rejects(f.manager.collect(job.delivery_id), error => ['UNSUPPORTED_FILE', 'SYMLINK_NOT_SUPPORTED'].includes(error.code))
  } finally { await f.manager.dispose() }
})

test('managed storage canonicalizes directory aliases before containment checks', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'))
  await f.manager.dispose()
  const alias = join(f.root, 'state-alias')
  await symlink(f.options.stateDirectory, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const manager = new DeliveryManager({ ...f.options, stateDirectory: alias })
  try {
    assert.equal(manager.root, await realpath(f.options.stateDirectory))
    const job = await manager.start(f.args)
    assert.equal((await manager.collect(job.delivery_id)).phase, 'ready_for_review')
  } finally { await manager.dispose() }
})

test('deleted Git submodule cannot be delivered as regular files', async () => {
  const f = await fixture(async cwd => { await writeFile(join(cwd, 'a.txt'), 'new'); await rmdir(join(cwd, 'submodule')) })
  try {
    const head = git(f.repo, 'rev-parse', 'HEAD').trim()
    git(f.repo, 'update-index', '--add', '--cacheinfo', `160000,${head},submodule`)
    git(f.repo, 'commit', '-qm', 'gitlink baseline')
    await mkdir(join(f.repo, 'submodule'))
    const job = await f.manager.start({ ...f.args, allowed_paths: [...f.args.allowed_paths, 'submodule'] })
    await assert.rejects(f.manager.collect(job.delivery_id), error => ['UNSUPPORTED_FILE', 'NO_CHANGES'].includes(error.code))
  } finally { await f.manager.dispose() }
})

test('failed actual command prevents acceptance', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'), 'console.error("real failure"); process.exit(7)')
  try {
    const job = await f.manager.start(f.args), result = await f.manager.collect(job.delivery_id)
    assert.equal(result.phase, 'verification_failed'); assert.equal(result.manifest.verification[0].exit_code, 7)
    await rejects(f.manager.accept(job.delivery_id), 'DELIVERY_NOT_VERIFIED')
    assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), 'old\n')
  } finally { await f.manager.dispose() }
})

test('verification that changes source invalidates evidence', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'), 'require("fs").writeFileSync("a.txt", "test mutated source")')
  try { const job = await f.manager.start(f.args); await rejects(f.manager.collect(job.delivery_id), 'VERIFICATION_CHANGED_FILES') }
  finally { await f.manager.dispose() }
})

test('ignored worker dependencies cannot make the collected patch appear verified', async () => {
  const f = await fixture(async cwd => { await writeFile(join(cwd, 'a.txt'), 'new'); await writeFile(join(cwd, 'hidden.json'), '{}') }, 'require("fs").readFileSync("hidden.json"); console.log("passed")')
  try {
    await writeFile(join(f.repo, '.gitignore'), 'hidden.json\n'); git(f.repo, 'add', '.gitignore'); git(f.repo, 'commit', '-qm', 'ignore fixture input')
    const job = await f.manager.start(f.args), result = await f.manager.collect(job.delivery_id)
    assert.equal(result.phase, 'verification_failed')
    assert.equal(result.manifest.verification_source, 'clean-baseline-plus-patch')
    assert.deepEqual(result.manifest.files.map(file => file.path), ['a.txt'])
    assert.match(result.manifest.verification[0].stderr_summary, /ENOENT/)
    await rejects(f.manager.accept(job.delivery_id), 'DELIVERY_NOT_VERIFIED')
  } finally { await f.manager.dispose() }
})

test('caller scope cannot override owner-protected verification inputs', async () => {
  const f = await fixture(async cwd => { await writeFile(join(cwd, 'a.txt'), 'new'); await writeFile(join(cwd, 'runner.mjs'), 'process.exit(0)') })
  try {
    await writeFile(join(f.repo, 'runner.mjs'), 'process.exit(1)'); git(f.repo, 'add', 'runner.mjs'); git(f.repo, 'commit', '-qm', 'trusted runner')
    f.manager.recipes.get('test').protected_paths = ['runner.mjs']
    const job = await f.manager.start({ ...f.args, allowed_paths: [...f.args.allowed_paths, 'runner.mjs'] })
    await rejects(f.manager.collect(job.delivery_id), 'VERIFICATION_INPUT_MODIFIED')
  } finally { await f.manager.dispose() }
})

test('interrupted verification resumes from durable patch into a fresh clean worktree', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'desired change'))
  let manager = f.manager
  try {
    const job = await manager.start(f.args)
    manager.verify = async (_job, _dir, _hash, cwd) => { await writeFile(join(cwd, 'a.txt'), 'contaminated by test'); throw new Error('simulated process interruption') }
    await assert.rejects(manager.collect(job.delivery_id))
    // Model the last durable state before Host death, without executing its catch handler.
    manager.require(job.delivery_id).phase = 'collecting'; manager.save()
    await manager.dispose(); manager = new DeliveryManager(f.options)
    const recovered = await manager.collect(job.delivery_id)
    assert.equal(recovered.phase, 'ready_for_review')
    assert.doesNotMatch(await readFile(recovered.manifest.patch_path, 'utf8'), /contaminated/)
    assert.equal(await readFile(join(recovered.verification_worktree, 'a.txt'), 'utf8'), 'desired change')
  } finally { await manager.dispose() }
})

for (const kind of ['patch', 'manifest', 'log', 'dirty', 'head']) test('acceptance refuses ' + kind, async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'))
  try {
    const job = await f.manager.start(f.args), ready = await f.manager.collect(job.delivery_id)
    if (kind === 'patch') await writeFile(ready.manifest.patch_path, 'tampered')
    if (kind === 'manifest') await writeFile(ready.manifest_path, '{}')
    if (kind === 'log') await writeFile(ready.manifest.verification[0].log_path, 'tampered')
    if (kind === 'dirty') await writeFile(join(f.repo, 'a.txt'), 'user edit')
    if (kind === 'head') git(f.repo, 'commit', '--allow-empty', '-qm', 'new head')
    await rejects(f.manager.accept(job.delivery_id), kind === 'dirty' ? 'TARGET_DIRTY' : kind === 'head' ? 'STALE_BASELINE' : 'ARTIFACT_CHANGED')
    assert.equal(await readFile(join(f.repo, 'a.txt'), 'utf8'), kind === 'dirty' ? 'user edit' : 'old\n')
  } finally { await f.manager.dispose() }
})

test('uncertain admission is persisted and never resubmitted', async () => {
  const f = await fixture()
  let calls = 0, manager = f.manager
  f.options.backend.sendText = async () => { calls++; throw new Error('lost connection') }
  try {
    await assert.rejects(manager.start(f.args))
    await manager.dispose(); manager = new DeliveryManager(f.options)
    const job = await manager.start(f.args)
    assert.equal(job.phase, 'submission_unknown'); assert.equal(calls, 1)
    assert.equal((await manager.reject(job.delivery_id)).unresolved_execution, true)
  } finally { await manager.dispose() }
})

test('delivery recovers admitted task by durable submission key without resending', async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'))
  let calls = 0, manager = f.manager
  f.options.backend.sendText = async () => { calls++; throw new Error('lost return value') }
  f.options.backend.lookupTask = async (_session, key) => { assert.match(key, /^delivery:/); return { task_id: 'recovered' } }
  try {
    await assert.rejects(manager.start(f.args))
    await manager.dispose(); manager = new DeliveryManager(f.options)
    const job = await manager.start(f.args), recovered = await manager.status(job.delivery_id)
    assert.equal(recovered.task_id, 'recovered'); assert.equal(recovered.phase, 'awaiting_collection'); assert.equal(calls, 1)
  } finally { await manager.dispose() }
})

for (const complete of [true, false]) test('interrupted applying reconciliation: ' + complete, async () => {
  const f = await fixture(cwd => writeFile(join(cwd, 'a.txt'), 'new'))
  let manager = f.manager
  try {
    const job = await manager.start(f.args), ready = await manager.collect(job.delivery_id)
    if (complete) git(f.repo, 'apply', '--binary', ready.manifest.patch_path)
    manager.require(job.delivery_id).phase = 'applying'; manager.save()
    await manager.dispose(); manager = new DeliveryManager(f.options)
    if (complete) assert.equal((await manager.accept(job.delivery_id)).recovered_after_apply, true)
    else await rejects(manager.accept(job.delivery_id), 'APPLY_UNCERTAIN')
  } finally { await manager.dispose() }
})
