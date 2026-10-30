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
