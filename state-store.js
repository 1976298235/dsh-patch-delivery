import { mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { createHash, randomUUID } from 'node:crypto'

export const digest = (value) => createHash('sha256').update(value).digest('hex')

// One Host writer per file. Reload must dispose the previous owner before opening it.
export class StateFile {
  constructor(filename) {
    this.filename = filename ? resolve(filename) : null
    this.token = randomUUID()
    this.closed = false
    if (!this.filename) { this.data = null; return }
    mkdirSync(dirname(this.filename), { recursive: true, mode: 0o700 })
    this.lock = this.filename + '.lock'
    this.acquire()
    try {
      const envelope = JSON.parse(readFileSync(this.filename, 'utf8'))
      if (envelope.version !== 1 || envelope.checksum !== digest(JSON.stringify(envelope.data))) throw new Error('State checksum/version mismatch.')
      this.data = envelope.data
    } catch (error) {
      if (error.code === 'ENOENT') this.data = null
      else { this.dispose(); throw Object.assign(new Error(`Cannot load state file: ${error.message}`), { code: 'STATE_CORRUPT' }) }
    }
  }

  acquire() {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(this.lock, 'wx', 0o600)
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, token: this.token })); fsyncSync(fd) } finally { closeSync(fd) }
        return
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        let owner
        try { owner = JSON.parse(readFileSync(this.lock, 'utf8')) } catch { throw Object.assign(new Error('Unreadable state lock; manual inspection required.'), { code: 'STATE_LOCKED' }) }
        if (!Number.isInteger(owner.pid) || owner.pid <= 0) throw new Error('Invalid state lock owner.')
        try { process.kill(owner.pid, 0) } catch (probe) {
          if (probe.code === 'ESRCH') { unlinkSync(this.lock); continue }
        }
        throw Object.assign(new Error('State is already owned by a live Host.'), { code: 'STATE_LOCKED' })
      }
    }
    throw new Error('Could not acquire state lock.')
  }

  write(data) {
    if (this.closed) throw new Error('State owner has been disposed.')
    if (!this.filename) { this.data = data; return }
    const temporary = this.filename + '.' + this.token + '.tmp'
    const fd = openSync(temporary, 'w', 0o600)
    try {
      writeFileSync(fd, JSON.stringify({ version: 1, checksum: digest(JSON.stringify(data)), data }), 'utf8')
      fsyncSync(fd)
    } finally { closeSync(fd) }
    renameSync(temporary, this.filename)
    this.data = data
  }

  dispose() {
    if (this.closed) return
    this.closed = true
    if (!this.lock) return
    try {
      const owner = JSON.parse(readFileSync(this.lock, 'utf8'))
      if (owner.token === this.token) unlinkSync(this.lock)
    } catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}
