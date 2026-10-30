// dsh-remote — 本机 WSL 接入。
//
// Windows 上的 WSL 对 Windows 进程暴露两样东西：一个 UNC 命名空间
// （\\wsl.localhost\<发行版>\…，旧系统为 \\wsl$\<发行版>\…）和 wsl.exe。
// 本模块把这两样包装成与 SSH 后端同形的能力（WslSftp / WslPool），使
// buildSftpSurface() 之上的镜像、同步、搜索与 rw_* 工具完全不用知道
// "远端"其实是本机的 WSL 文件系统。
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'
import { buildSftpSurface } from './sftp-surface.js'
import { shq } from './paths.js'

export const WSL_HOST_PREFIX = 'wsl:'

/** Machine host values are `wsl:<distro>` so they can never collide with SSH. */
export function isWslHost(host) {
  return String(host || '').startsWith(WSL_HOST_PREFIX)
}

export function distroOfHost(host) {
  const h = String(host || '')
  return isWslHost(h) ? h.slice(WSL_HOST_PREFIX.length) : ''
}

export function wslHostFor(distro) {
  return WSL_HOST_PREFIX + String(distro)
}

/** `wsl.exe -l -q` prints UTF-16LE, NUL-padded, one distro per line. */
export function parseDistroList(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf16le') : String(buf || '')
  return text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((s) => s.replace(/\0/g, '').trim())
    .filter(Boolean)
}

/** WSL paths are Linux absolute paths; `C:\…` is a user error worth naming. */
export function isWslLinuxPath(p) {
  const s = String(p || '')
  return s.startsWith('/') && !s.startsWith('//')
}

const UNC_ROOTS = ['\\\\wsl.localhost', '\\\\wsl$']

/** Pick the first UNC namespace this Windows build exposes (empty when none). */
export function detectUncRoot(distro, deps = {}) {
  const exists = deps.exists || ((p) => existsSync(p))
  for (const base of UNC_ROOTS) {
    const root = `${base}\\${distro}`
    if (exists(root)) return root
  }
  return ''
}

/**
 * Linux path → Windows path under the distro's UNC root.
 *
 * No `.`/`..` collapsing: callers already normalize remote paths, and the
 * Windows filesystem resolves `..` itself — rewriting it here would desync the
 * path the caller echoes back to the user.
 */
export function wslPathToUnc(linuxPath, distro, uncRoot) {
  if (!isWslLinuxPath(linuxPath)) {
    throw new Error('WSL 使用 Linux 路径，例如 /home/you/project')
  }
  const root = uncRoot || detectUncRoot(distro)
  if (!root) throw new Error(`无法访问 \\\\wsl.localhost\\${distro}，请确认发行版已启动（wsl -d ${distro} -- true）`)
  const base = String(root).replace(/\\+$/, '')
  const rel = String(linuxPath).replace(/^\/+/, '').split('/').filter(Boolean)
  return rel.length ? base + '\\' + rel.join('\\') : base + '\\'
}

/** ssh2 callbacks are optional here so unit tests can `await` the same calls. */
function settle(promise, cb) {
  if (typeof cb === 'function') promise.then((value) => cb(null, value), (err) => cb(err))
  return promise
}

/** ssh2 reports `mtime` in seconds; Node reports milliseconds. */
function attrsOf(st) {
  return {
    size: st.size,
    mtime: Math.floor(st.mtimeMs / 1000),
    atime: Math.floor(st.atimeMs / 1000),
    mode: st.mode,
    uid: 0,
    gid: 0,
    isDirectory: () => st.isDirectory(),
    isFile: () => st.isFile(),
    isSymbolicLink: () => st.isSymbolicLink(),
  }
}

/**
 * ssh2-shaped SFTP primitives over a WSL UNC root.
 *
 * Callers above buildSftpSurface() keep speaking Linux paths; this class is the
 * only place that knows they live under `\\wsl.localhost\<distro>`.
 */
export class WslSftp extends EventEmitter {
  constructor({ distro, uncRoot, deps = {} } = {}) {
    super()
    this.distro = distro
    this.uncRoot = uncRoot || ''
    this.fs = deps.fs || fsp
  }

  _p(linuxPath) {
    if (!this.uncRoot) this.uncRoot = detectUncRoot(this.distro)
    return wslPathToUnc(linuxPath, this.distro, this.uncRoot)
  }

  readdir(linuxPath, cb) {
    const pr = this.fs.readdir(this._p(linuxPath), { withFileTypes: true }).then(async (entries) => {
      const out = []
      for (const e of entries) {
        const full = path.posix.join(linuxPath, e.name)
        let st
        try { st = await this.fs.lstat(this._p(full)) } catch { continue }
        out.push({ filename: e.name, longname: e.name, attrs: attrsOf(st) })
      }
      return out
    })
    return settle(pr, cb)
  }

  stat(p, cb) {
    return settle(this.fs.stat(this._p(p)).then(attrsOf), cb)
  }

  lstat(p, cb) {
    return settle(this.fs.lstat(this._p(p)).then(attrsOf), cb)
  }

  mkdir(p, cb) {
    return settle(this.fs.mkdir(this._p(p)), cb)
  }

  rmdir(p, cb) {
    return settle(this.fs.rmdir(this._p(p)), cb)
  }

  unlink(p, cb) {
    return settle(this.fs.unlink(this._p(p)), cb)
  }

  rename(a, b, cb) {
    return settle(this.fs.rename(this._p(a), this._p(b)), cb)
  }

  realpath(p, cb) {
    return settle(
      this.fs.realpath(this._p(p)).then((abs) => '/' + path.relative(this.uncRoot, abs).split(path.sep).join('/')),
      cb,
    )
  }

  setstat(p, attrs, cb) {
    const pr = attrs && typeof attrs.mode === 'number'
      ? this.fs.chmod(this._p(p), attrs.mode)
      : Promise.resolve()
    return settle(pr, cb)
  }

  readFile(p, cb) {
    return settle(this.fs.readFile(this._p(p)), cb)
  }

  writeFile(p, data, cb) {
    return settle(this.fs.writeFile(this._p(p), data), cb)
  }

  fastGet(p, local, cb) {
    return settle(this.fs.copyFile(this._p(p), local), cb)
  }

  fastPut(local, p, cb) {
    return settle(this.fs.copyFile(local, this._p(p)), cb)
  }

  /** Handles for readPartial(); ssh2 callers pass a handle string, we pass one. */
  open(linuxPath, flags, cb) {
    return settle(this.fs.open(this._p(linuxPath), flags === 'r' ? 'r' : flags), cb)
  }

  read(handle, buf, offset, length, position, cb) {
    const pr = typeof handle.read === 'function'
      ? handle.read(buf, offset, length, position)
      : this.fs.read(handle, buf, offset, length, position)
    pr.then((r) => cb(null, r.bytesRead, buf), (err) => cb(err))
  }

  close(handle, cb) {
    const pr = typeof handle.close === 'function' ? handle.close() : this.fs.close(handle)
    return settle(pr, cb)
  }
}

/** Distro names as `wsl.exe -l -q` reports them; [] when WSL is unavailable. */
export async function listDistros({ spawnImpl = spawn, platform = process.platform } = {}) {
  if (platform !== 'win32') return []
  return new Promise((resolve) => {
    let proc
    try {
      proc = spawnImpl('wsl.exe', ['-l', '-q'], { windowsHide: true })
    } catch {
      return resolve([])
    }
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
    proc.on('error', () => resolve([]))
    proc.on('close', () => resolve(parseDistroList(Buffer.concat(chunks))))
  })
}

/**
 * The transport half of WSL: same surface as SshPool (connect/exec/sftp/detect/
 * shell/invalidate/close/setTarget) so ActivePool and poolForMachine can use it
 * without knowing which backend is behind the machine.
 */
export class WslPool {
  constructor(config = {}, opts = {}) {
    this.config = config
    this.opts = opts
    this.distro = String(config.distro || distroOfHost(config.host) || '')
    this.spawnImpl = opts.spawnImpl || spawn
    this.platformName = opts.platform || process.platform
    this.client = null
    // SshPool exposes the detected runtime platform here; WSL is always Linux.
    this.platform = 'linux'
    this.shellMode = 'native'
    this._uncRoot = ''
    this._sftp = null
  }

  async connect() {
    if (this.platformName !== 'win32') throw new Error('仅 Windows 支持 WSL')
    if (!this.distro) throw new Error('WSL 缺少发行版名')
    const distros = await (this.opts.listDistrosImpl || listDistros)({ spawnImpl: this.spawnImpl, platform: this.platformName })
    if (!distros.includes(this.distro)) {
      throw new Error(`WSL 发行版 "${this.distro}" 不存在（wsl -l -q 中未找到）`)
    }
    this._uncRoot = (this.opts.detectRoot || detectUncRoot)(this.distro)
    if (!this._uncRoot) {
      throw new Error(`无法访问 \\\\wsl.localhost\\${this.distro}，请确认发行版已启动（wsl -d ${this.distro} -- true）`)
    }
    this.client = { wsl: true }
  }

  async detect() { /* platform is known from the start */ }

  async sftp() {
    if (!this._sftp) {
      if (!this._uncRoot) this._uncRoot = (this.opts.detectRoot || detectUncRoot)(this.distro)
      this._sftp = buildSftpSurface(new WslSftp({ distro: this.distro, uncRoot: this._uncRoot }), {
        commandTimeoutMs: this.config.commandTimeoutMs || 20000,
      })
    }
    return this._sftp
  }

  /**
   * Run one command in the distro. The script goes through stdin (`bash -s`)
   * so no Windows-side quoting is involved; only spawn failures and timeouts
   * reject — a non-zero exit is the caller's business, like SshPool.exec.
   */
  exec(command, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs || this.config.commandTimeoutMs || 20000)
    const cwd = String(opts.cwd || this.config.workspace || '')
    const script = (cwd ? `cd ${shq(cwd)} && ` : '') + String(command)
    return new Promise((resolve, reject) => {
      let proc
      try {
        proc = this.spawnImpl('wsl.exe', ['-d', this.distro, '--', 'bash', '-s'], { windowsHide: true })
      } catch (err) {
        return reject(err)
      }
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        try { proc.kill() } catch { /* already gone */ }
        reject(new Error(`WSL command timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      proc.stdout.on('data', (d) => { stdout += d })
      proc.stderr.on('data', (d) => { stderr += d })
      proc.on('error', (err) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err)
      })
      proc.on('close', (code) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve({ stdout, stderr, code: code == null ? 0 : code })
      })
      try {
        proc.stdin.write(script + '\n')
        proc.stdin.end()
      } catch { /* the spawn error path above reports it */ }
    })
  }

  async shell() { throw new Error('WSL 终端暂不支持（v1）') }

  invalidate() {
    this._sftp = null
    this._uncRoot = ''
  }

  close() {
    this.client = null
    this._sftp = null
  }

  setTarget(fields = {}) {
    if (fields.distro) this.distro = fields.distro
    else if (fields.host) this.distro = distroOfHost(fields.host)
    Object.assign(this.config, fields)
    this.invalidate()
  }
}
