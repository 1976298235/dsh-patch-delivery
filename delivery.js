import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile, realpath, lstat, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { StateFile, digest } from './state-store.js'

const exec = promisify(execFile)
const fail = (code, message) => { throw Object.assign(new Error(message), { code }) }
const inside = (parent, child) => { const path = relative(parent, child); return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith('..' + sep)) }
const canonical = (value) => JSON.stringify(value, Object.keys(value).sort())
const terminal = new Set(['completed', 'failed', 'cancelled'])

function scopePath(path) {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || isAbsolute(path) || /^[A-Za-z]:/.test(path)) fail('INVALID_SCOPE', 'Scopes must be relative POSIX file paths or directory prefixes ending in /.')
  const parts = path.replace(/\/$/, '').split('/')
  if (parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git' || part.includes(':'))) fail('INVALID_SCOPE', 'Scope contains a forbidden path component.')
  return path
}
const allowed = (path, scopes) => scopes.some((scope) => scope.endsWith('/') ? path.startsWith(scope) : path === scope)

export class DeliveryManager {
  constructor({ stateDirectory, backend, recipes = [] }) {
    this.root = resolve(stateDirectory)
    this.store = new StateFile(join(this.root, 'deliveries.json'))
    this.root = realpathSync.native(this.root) // Match promises.realpath: expand Windows 8.3 aliases.
    this.jobs = new Map((this.store.data?.jobs ?? []).map((job) => [job.delivery_id, job]))
    this.backend = backend
    this.recipes = new Map()
    this.operations = Promise.resolve()
    for (const recipe of recipes) {
      if (typeof recipe.id !== 'string' || !recipe.id.trim() || this.recipes.has(recipe.id) || typeof recipe.executable !== 'string' || !isAbsolute(recipe.executable) || !Array.isArray(recipe.args) || recipe.args.some((arg) => typeof arg !== 'string') || (recipe.timeout_ms !== undefined && (!Number.isInteger(recipe.timeout_ms) || recipe.timeout_ms < 1000 || recipe.timeout_ms > 120000)) || (recipe.env !== undefined && (!recipe.env || Array.isArray(recipe.env) || typeof recipe.env !== 'object' || Object.entries(recipe.env).some(([key, value]) => !key || key.includes('=') || key.includes('\0') || typeof value !== 'string' || value.includes('\0'))))) {
        this.store.dispose(); fail('INVALID_RECIPE', 'Recipes need unique ids, an absolute executable, and a string args array.')
      }
      try {
        if (recipe.protected_paths !== undefined && !Array.isArray(recipe.protected_paths)) fail('INVALID_RECIPE', 'protected_paths must be an array.')
        recipe.protected_paths = [...new Set((recipe.protected_paths ?? []).map(scopePath))]
      } catch (error) { this.store.dispose(); throw error }
      this.recipes.set(recipe.id, { ...recipe, timeout_ms: Math.min(Math.max(recipe.timeout_ms ?? 60000, 1000), 120000) })
    }
  }

  serial(fn) {
    const result = this.operations.then(fn)
    this.operations = result.catch(() => {})
    return result
  }
  save() { this.store.write({ jobs: [...this.jobs.values()] }) }
  snapshot(job) { return JSON.parse(JSON.stringify(job)) }
  require(id) { const job = this.jobs.get(id); if (!job) fail('DELIVERY_NOT_FOUND', 'Unknown delivery_id.'); return job }
  async dispose() { await this.operations; this.store.dispose() }

  async git(cwd, args, options = {}) {
    const env = { ...process.env }
    // Git routing/index overrides must not redirect repository operations.
    for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key]
    Object.assign(env, options.env ?? {})
    const result = await exec('git', ['-c', 'core.hooksPath=' + join(this.root, 'empty-hooks'), '-c', 'core.fsmonitor=false', '-C', cwd, ...args], {
      windowsHide: true, shell: false, timeout: 30000, maxBuffer: 16 * 1024 * 1024, encoding: 'buffer', ...options, env,
    })
    return result.stdout
  }
  async head(cwd) { return (await this.git(cwd, ['rev-parse', 'HEAD'])).toString().trim() }
  async statusBytes(cwd) { return this.git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all']) }
  async common(cwd) { return realpath((await this.git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).toString().trim()) }
  async ensureWorktree(job) {
    if (!inside(join(this.root, 'worktrees'), job.worktree) || await realpath(job.worktree) !== job.worktree) fail('WORKTREE_MOVED', 'Worktree path changed or escaped managed storage.')
    if (await this.head(job.worktree) !== job.baseline_commit || await this.common(job.worktree) !== job.git_common_directory) fail('WORKTREE_HEAD_CHANGED', 'Worker changed the Git baseline or repository identity.')
  }
  async checkPath(root, path) {
    scopePath(path)
    const target = resolve(root, path)
    if (!inside(root, target)) fail('PATH_ESCAPE', 'Changed path escapes the worktree.')
    let cursor = root
    const parts = path.split('/')
    for (const part of parts) {
      cursor = join(cursor, part)
      try {
        const info = await lstat(cursor)
        if (info.isSymbolicLink()) fail('SYMLINK_NOT_SUPPORTED', 'Symlink changes or symlink parents are not supported.')
        if (cursor === target && !info.isFile()) fail('UNSUPPORTED_FILE', 'Only regular file changes are supported.')
      } catch (error) { if (error.code === 'ENOENT') break; throw error }
    }
    return target
  }

  start(args) { return this.serial(async () => {
    if (typeof args.text !== 'string' || !args.text.trim() || typeof args.idempotency_key !== 'string' || !args.idempotency_key.trim() || args.idempotency_key.length > 256) fail('INVALID_ARGUMENT', 'text and a nonempty idempotency_key (max 256 chars) are required.')
    if (!Array.isArray(args.allowed_paths) || !args.allowed_paths.length) fail('INVALID_SCOPE', 'allowed_paths is required.')
    const scopes = [...new Set(args.allowed_paths.map(scopePath))].sort()
    if (args.agent_preset !== undefined && (typeof args.agent_preset !== 'string' || !args.agent_preset.trim())) fail('INVALID_ARGUMENT', 'agent_preset must be a nonblank string.')
    if (!Array.isArray(args.verification_ids) || !args.verification_ids.length || args.verification_ids.some((id) => typeof id !== 'string' || !this.recipes.has(id))) fail('UNKNOWN_RECIPE', 'Choose at least one owner-configured verification recipe.')
    const repo = await realpath(args.repo)
    const top = await realpath((await this.git(repo, ['rev-parse', '--show-toplevel'])).toString().trim())
    if (repo !== top) fail('REPO_ROOT_REQUIRED', 'repo must be the Git repository root.')
    if (inside(repo, this.root)) fail('NESTED_STATE', 'Delivery storage must be outside the source repository.')
    const recipeIds = [...new Set(args.verification_ids)].sort()
    const fingerprint = digest(canonical({ repo, text: args.text, allowed_paths: scopes, verification_ids: recipeIds, ...(args.agent_preset ? { agent_preset: args.agent_preset } : {}) }))
    const prior = [...this.jobs.values()].find((job) => job.idempotency_key === args.idempotency_key)
    if (prior) {
      if (prior.fingerprint !== fingerprint) fail('IDEMPOTENCY_CONFLICT', 'This delivery key was used with different arguments.')
      return this.snapshot(prior) // Never restart uncertain preparation or admission.
    }
    if ((await this.statusBytes(repo)).length) fail('DIRTY_WORKTREE', 'Source repository must be clean, including untracked files; existing changes are preserved.')
    if (this.jobs.size >= 500) fail('CAPACITY_EXCEEDED', 'Delivery history capacity reached; archive/export it before starting more work.')
    const id = randomUUID()
    await mkdir(join(this.root, 'worktrees'), { recursive: true, mode: 0o700 })
    await mkdir(join(this.root, 'empty-hooks'), { recursive: true, mode: 0o700 })
    const job = { delivery_id: id, idempotency_key: args.idempotency_key, fingerprint, repo, baseline_commit: await this.head(repo),
      git_common_directory: await this.common(repo), allowed_paths: scopes, verification_ids: recipeIds, agent_preset: args.agent_preset ?? null,
      worktree: join(this.root, 'worktrees', id), phase: 'preparing', session_id: null, task_id: null,
      submission_key: 'delivery:' + id,
      created_at: Date.now(), updated_at: Date.now(), manifest: null, error: null }
    this.jobs.set(id, job); this.save()
    try {
      await this.git(repo, ['worktree', 'add', '--detach', '--', job.worktree, job.baseline_commit])
      job.worktree = await realpath(job.worktree)
      job.session_id = await this.backend.createSession(job.worktree, job.agent_preset)
      job.phase = 'submission_unknown'; this.save()
      const prompt = `Execute this code task only in ${job.worktree}. The original repository ${repo} must remain untouched. Allowed changed paths: ${scopes.join(', ')}. Do not commit, change HEAD, edit Git metadata, merge, push, or delegate to another agent. Verification is performed separately by the delivery service. Report what you changed.\n\n${args.text}`
      const submitted = await this.backend.sendText(job.session_id, prompt, job.submission_key)
      job.task_id = submitted.task_id
      if (!job.task_id) fail('SUBMISSION_UNCERTAIN', 'No task_id was returned; do not resubmit.')
      job.phase = 'executing'; job.updated_at = Date.now(); this.save()
      return this.snapshot(job)
    } catch (error) {
      job.error = { code: error.code ?? 'PREPARATION_FAILED', message: error.message }
      if (job.phase === 'preparing') job.phase = 'preparation_failed'
      if (error.task?.task_id) job.task_id = error.task.task_id
      this.save(); error.delivery = this.snapshot(job); throw error
    }
  }) }

  async refresh(job) {
    if (job.phase === 'submission_unknown' && !job.task_id && job.session_id && this.backend.lookupTask) {
      const recovered = await this.backend.lookupTask(job.session_id, job.submission_key ?? 'delivery:' + job.delivery_id)
      if (recovered?.task_id) { job.task_id = recovered.task_id; job.recovered_submission = true; this.save() }
    }
    if (job.task_id && ['executing', 'submission_unknown'].includes(job.phase)) {
      const task = await this.backend.getTask(job.task_id)
      job.task_status = task.status
      if (terminal.has(task.status)) job.phase = task.status === 'completed' ? 'awaiting_collection' : 'execution_failed'
      job.updated_at = Date.now(); this.save()
    }
    return job
  }
  status(id) { return this.serial(async () => this.snapshot(await this.refresh(this.require(id)))) }

  async patch(job, cwd = job.worktree) {
    if (cwd === job.worktree) await this.ensureWorktree(job)
    const paths = [...new Set([
      ...(await this.git(cwd, ['diff', '--name-only', '--no-renames', '-z', job.baseline_commit, '--'])).toString().split('\0'),
      ...(await this.git(cwd, ['ls-files', '--others', '--exclude-standard', '-z'])).toString().split('\0'),
    ].filter(Boolean))].sort()
    for (const path of paths) {
      if (!allowed(path, job.allowed_paths)) fail('OUT_OF_SCOPE', `Changed file outside allowed_paths: ${path}`)
      await this.checkPath(cwd, path)
    }
    const index = join(this.root, 'index-' + randomUUID())
    const env = { GIT_INDEX_FILE: index }
    try {
      await this.git(cwd, ['read-tree', job.baseline_commit], { env })
      await this.git(cwd, ['add', '-A', '--', '.'], { env })
      const raw = (await this.git(cwd, ['diff', '--cached', '--raw', '--no-renames', job.baseline_commit, '--'], { env })).toString()
      if (raw.split('\n').some((line) => /^:(?:\d+ )?(?:120000|160000)\b/.test(line) || /^:\d+ (?:120000|160000)\b/.test(line))) fail('UNSUPPORTED_FILE', 'Symlinks and submodules cannot be delivered.')
      const patch = await this.git(cwd, ['diff', '--cached', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', job.baseline_commit, '--'], { env })
      const files = []
      for (const path of paths) {
        const target = await this.checkPath(cwd, path)
        let after = null
        try { after = digest(await readFile(target)) } catch (error) { if (error.code !== 'ENOENT') throw error }
        let before = null
        try { before = digest(await this.git(cwd, ['show', job.baseline_commit + ':' + path])) } catch (error) { if (after === null) throw error }
        files.push({ path, change: before === null ? 'added' : after === null ? 'deleted' : 'modified', before_sha256: before, after_sha256: after })
      }
      return { patch, files, sha256: digest(patch) }
    } finally { try { await unlink(index) } catch (error) { if (error.code !== 'ENOENT') throw error } }
  }

  async verify(job, artifactDirectory, patchSha, verificationWorktree) {
    const results = []
    for (const id of job.verification_ids) {
      const recipe = this.recipes.get(id)
      if (!recipe) fail('UNKNOWN_RECIPE', 'A configured recipe was removed; reconfigure it before collecting.')
      const env = { CI: 'true' }
      for (const key of ['PATH', 'Path', 'PATHEXT', 'SystemRoot', 'WINDIR', 'ComSpec', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG']) if (process.env[key]) env[key] = process.env[key]
      Object.assign(env, recipe.env ?? {})
      const start = Date.now()
      let stdout = '', stderr = '', exitCode = null, errorCode = null
      try {
        const result = await exec(recipe.executable, recipe.args, { cwd: verificationWorktree, env, shell: false, windowsHide: true, timeout: recipe.timeout_ms, maxBuffer: 1024 * 1024, encoding: 'utf8' })
        stdout = result.stdout; stderr = result.stderr; exitCode = 0
      } catch (error) {
        stdout = String(error.stdout ?? ''); stderr = String(error.stderr ?? error.message)
        if (typeof error.code === 'number') exitCode = error.code
        errorCode = error.killed ? 'TIMEOUT' : String(error.code ?? 'VERIFICATION_FAILED')
      }
      const log = stdout + '\n--- stderr ---\n' + stderr
      const logFile = join(artifactDirectory, 'verification-' + results.length + '.log')
      await writeFile(logFile, log, { mode: 0o600 })
      results.push({ id, command: { executable: recipe.executable, args: recipe.args }, protected_paths: recipe.protected_paths,
        recipe_sha256: digest(JSON.stringify({ executable: recipe.executable, args: recipe.args, timeout_ms: recipe.timeout_ms, protected_paths: recipe.protected_paths, env: recipe.env ?? {} })),
        source_patch_sha256: patchSha, exit_code: exitCode, error_code: errorCode, passed: exitCode === 0,
        duration_ms: Date.now() - start, log_path: logFile, log_sha256: digest(log), stdout_summary: stdout.slice(-4000), stderr_summary: stderr.slice(-4000) })
    }
    return results
  }

  collect(id) { return this.serial(async () => {
    const job = await this.refresh(this.require(id))
    if (['ready_for_review', 'verification_failed', 'accepted', 'rejected'].includes(job.phase)) return this.snapshot(job)
    if (job.phase !== 'awaiting_collection' && job.phase !== 'collecting') fail('TASK_NOT_COMPLETED', 'Only a successfully completed task can be collected.')
    const interrupted = job.phase === 'collecting'
    job.phase = 'collecting'; this.save()
    try {
      if (interrupted && !job.collection_snapshot) fail('COLLECTION_INTERRUPTED', 'No durable pre-verification snapshot exists; inspect the worktree before creating another delivery.')
      const worker = await this.patch(job)
      let artifact = worker
      if (job.collection_snapshot) {
        const snapshot = job.collection_snapshot
        const patch = await readFile(snapshot.patch_path)
        if (digest(patch) !== snapshot.sha256) fail('ARTIFACT_CHANGED', 'Interrupted collection snapshot changed.')
        if (worker.sha256 !== snapshot.sha256 || JSON.stringify(worker.files) !== JSON.stringify(snapshot.files)) fail('COLLECTION_SOURCE_CHANGED', 'Worker files changed after the durable collection snapshot.')
        artifact = { patch, files: snapshot.files, sha256: snapshot.sha256 }
      }
      if (!artifact.files.length || !artifact.patch.length) fail('NO_CHANGES', 'Task produced no deliverable changes.')
      for (const recipeId of job.verification_ids) {
        const recipe = this.recipes.get(recipeId)
        if (!recipe) fail('UNKNOWN_RECIPE', 'A configured recipe was removed.')
        for (const file of artifact.files) if (allowed(file.path, recipe.protected_paths)) fail('VERIFICATION_INPUT_MODIFIED', `Owner-protected verification input changed: ${file.path}`)
      }
      const directory = join(this.root, 'artifacts', job.delivery_id)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const patchPath = join(directory, 'changes.patch')
      await writeFile(patchPath, artifact.patch, { mode: 0o600 })
      job.collection_snapshot = { patch_path: patchPath, files: artifact.files, sha256: artifact.sha256 }
      this.save() // Immutable input is durable before any recipe runs.
      const verificationWorktree = join(this.root, 'verifications', job.delivery_id + '-' + randomUUID())
      await mkdir(join(this.root, 'verifications'), { recursive: true, mode: 0o700 })
      await this.git(job.repo, ['worktree', 'add', '--detach', '--', verificationWorktree, job.baseline_commit])
      await this.git(verificationWorktree, ['apply', '--binary', '--', patchPath])
      const reconstructed = await this.patch(job, verificationWorktree)
      if (reconstructed.sha256 !== artifact.sha256 || JSON.stringify(reconstructed.files) !== JSON.stringify(artifact.files)) fail('VERIFICATION_TREE_MISMATCH', 'Clean baseline plus patch does not reproduce the collected file snapshot.')
      job.verification_worktree = verificationWorktree; this.save()
      const verification = await this.verify(job, directory, artifact.sha256, verificationWorktree)
      const after = await this.patch(job, verificationWorktree)
      if (after.sha256 !== artifact.sha256 || JSON.stringify(after.files) !== JSON.stringify(artifact.files)) fail('VERIFICATION_CHANGED_FILES', 'Verification modified deliverable files; tests no longer match the original patch.')
      const currentWorker = await this.patch(job)
      if (currentWorker.sha256 !== artifact.sha256 || JSON.stringify(currentWorker.files) !== JSON.stringify(artifact.files)) fail('COLLECTION_SOURCE_CHANGED', 'Worker files changed during verification.')
      const manifest = { format: 1, delivery_id: job.delivery_id, baseline_commit: job.baseline_commit, repo: job.repo,
        worktree: job.worktree, files: artifact.files, patch_path: patchPath, patch_sha256: artifact.sha256,
        verification_worktree: verificationWorktree, verification_source: 'clean-baseline-plus-patch',
        verification, verified: verification.length > 0 && verification.every((item) => item.passed), collected_at: Date.now() }
      const manifestText = JSON.stringify(manifest, null, 2) + '\n'
      job.manifest_path = join(directory, 'manifest.json')
      await writeFile(job.manifest_path, manifestText, { mode: 0o600 })
      job.manifest_sha256 = digest(manifestText); job.manifest = manifest
      job.phase = manifest.verified ? 'ready_for_review' : 'verification_failed'
      job.error = null; job.updated_at = Date.now(); this.save()
      return this.snapshot(job)
    } catch (error) {
      job.phase = 'collection_failed'; job.error = { code: error.code ?? 'COLLECTION_FAILED', message: error.message }; this.save(); throw error
    }
  }) }

  async checkedManifest(job) {
    const text = await readFile(job.manifest_path)
    if (digest(text) !== job.manifest_sha256) fail('ARTIFACT_CHANGED', 'Manifest changed after collection.')
    const manifest = JSON.parse(text.toString())
    const patch = await readFile(manifest.patch_path)
    if (digest(patch) !== manifest.patch_sha256) fail('ARTIFACT_CHANGED', 'Patch changed after collection.')
    for (const check of manifest.verification) if (digest(await readFile(check.log_path)) !== check.log_sha256) fail('ARTIFACT_CHANGED', 'Verification log changed after collection.')
    return { manifest, patch }
  }

  accept(id) { return this.serial(async () => {
    const job = this.require(id)
    if (job.phase === 'accepted') return this.snapshot(job)
    if (!['ready_for_review', 'applying'].includes(job.phase)) fail('DELIVERY_NOT_VERIFIED', 'Only a verified delivery can be accepted.')
    const { manifest } = await this.checkedManifest(job)
    if (!manifest.verified) fail('DELIVERY_NOT_VERIFIED', 'Verification did not pass.')
    if (await realpath(job.repo) !== job.repo || await this.common(job.repo) !== job.git_common_directory || await this.head(job.repo) !== job.baseline_commit) fail('STALE_BASELINE', 'Source repository identity or HEAD changed; do not apply this patch.')
    if (job.phase === 'applying') {
      const observed = await this.patch(job, job.repo)
      if (observed.sha256 !== manifest.patch_sha256) fail('APPLY_UNCERTAIN', 'Previous apply was interrupted and cannot be proven complete; inspect manually.')
      job.phase = 'accepted'; job.recovered_after_apply = true; job.updated_at = Date.now(); this.save(); return this.snapshot(job)
    }
    if ((await this.statusBytes(job.repo)).length) fail('TARGET_DIRTY', 'Source working tree changed after delegation; existing edits are preserved.')
    for (const file of manifest.files) await this.checkPath(job.repo, file.path)
    try { await this.git(job.repo, ['apply', '--check', '--binary', '--', manifest.patch_path]) } catch (error) { fail('PATCH_CONFLICT', 'Patch cannot be applied cleanly: ' + error.message) }
    job.phase = 'applying'; this.save()
    try {
      await this.git(job.repo, ['apply', '--binary', '--whitespace=nowarn', '--', manifest.patch_path])
      job.phase = 'accepted'; job.accepted_at = Date.now(); job.updated_at = Date.now(); this.save()
      return this.snapshot(job)
    } catch (error) {
      job.error = { code: 'APPLY_UNCERTAIN', message: error.message }; this.save()
      fail('APPLY_UNCERTAIN', 'Apply did not finish normally. State was retained; no automatic retry or rollback.')
    }
  }) }

  reject(id) { return this.serial(async () => {
    const job = this.require(id)
    if (job.phase === 'accepted' || job.phase === 'applying') fail('ALREADY_APPLIED', 'An applied or uncertain patch cannot be rejected automatically.')
    if (job.phase === 'executing') fail('TASK_RUNNING', 'Stop or resolve the task before rejecting its delivery.')
    if (['preparing', 'submission_unknown'].includes(job.phase)) job.unresolved_execution = true // Rejection is not cancellation.
    job.phase = 'rejected'; job.updated_at = Date.now(); this.save()
    return this.snapshot(job)
  }) }

  catalog() { return [...this.recipes.values()].map((recipe) => ({ id: recipe.id, executable: recipe.executable, args: recipe.args, timeout_ms: recipe.timeout_ms, protected_paths: recipe.protected_paths })) }
}
