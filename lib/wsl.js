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
