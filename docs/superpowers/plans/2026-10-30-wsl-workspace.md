# 本机 WSL 工作区 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在 Windows 上将本机 WSL 发行版作为 dsh-remote 的第三种接入后端，复用镜像、文件工具与 `rw_exec`。

**架构：** 新增 `lib/wsl.js`（发行版发现 + 路径映射 + `WslSftp` + `WslPool`），`createPool()` / `ActivePool` 按 `backend==='wsl'` 分派；`WslSftp` 用 Node `fs` 实现 ssh2 形状，`buildSftpSurface()` 之上的一切（sync/search/routes/rw_*）保持不变。WSL 机器在注册表里是普通记录，`kind:"wsl"`、`host:"wsl:<发行版>"`、`port:0`。

**技术栈：** Node 24（ESM）、`node:child_process`、`node:fs/promises`、`node:test`、React 18（客户端插件）。

**规格：** `docs/superpowers/specs/2026-10-30-wsl-workspace-design.md`

## 全局约束

- 仅 Windows：`process.platform === 'win32'` 之外，`/dsh-remote/wsl` 返回 `available:false`，所有 WSL 入口隐藏。
- WSL 机器身份固定为 `kind:"wsl"`、`host:"wsl:<发行版>"`、`port:0`、`username:""`；不得修改 `poolKey` 的 `u@h:22` 格式。
- WSL 路径一律是 Linux 绝对路径（`/home/...`）；传 `C:\...` 必须报错。
- v1 不支持：终端（PTY）、端口转发、体检/部署、远端 DSH 界面。入口隐藏 + 后端明确拒绝。
- 失败不得影响插件其它功能；所有 WSL 探测失败都要降级为「入口隐藏」。
- 测试命令：`node --import ./test/setup-telemetry-off.mjs test/<file>.test.js`（本机沙箱下 `node --test` 会 `spawn EPERM`，直接执行文件）。
- 每个任务结束提交一次；commit message 使用 `feat(wsl): ...` 前缀，不 bump 版本（版本与 CHANGELOG 在任务 9 统一处理）。

---

## 文件结构

| 文件 | 职责 |
| --- | --- |
| `lib/wsl.js`（新） | 全部 WSL 逻辑：可用性、发行版列表、路径映射、`WslSftp`、`WslPool`、`isWslBackend()` |
| `lib/pool.js`（改） | `createPool` 分派 WSL；`ActivePool` 识别 `WslPool` |
| `lib/registry.js`（改） | `applyMachine` 认识 `kind` / `distro` |
| `lib/binding.js`（改） | 无（`resolveMirror` 只读 host/port/username，保持不动） |
| `lib/index.js`（改） | `withSshConfig` 跳过 WSL；`ensureMirror` 写 `kind`；`machinesForClient` 附加标记；`/wsl`、`from-wsl` 路由；能力拒绝 |
| `lib/client.js`（改） | 「本机 WSL」卡片、机器行徽章、编辑表单裁剪、选择器下拉文案、能力区块隐藏 |
| `lib/routes-term.js` / `lib/remote-shell.js`（改） | WSL 会话拒绝终端 |
| `test/wsl.test.js`（新） | 检测/解析/路径映射 |
| `test/wsl-sftp.test.js`（新） | 适配器形状与语义 |
| `test/wsl-pool.test.js`（新） | 执行、超时、后端分派 |
| `test/wsl-routes.test.js`（新） | `/wsl` 与 `from-wsl` |
| `test/wsl-ui.test.js`（新） | 卡片、徽章、表单裁剪、能力隐藏 |
| `test/wsl-capability.test.js`（新） | 终端/部署/转发的拒绝 |

---

### 任务 1：发行版发现与路径映射

**文件：**
- 创建：`lib/wsl.js`
- 测试：`test/wsl.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDistroList, wslPathToUnc, isWslLinuxPath } from '../lib/wsl.js'

test('parseDistroList decodes UTF-16LE and drops blank lines', () => {
  const buf = Buffer.from('\uFEFFUbuntu\r\nDebian\r\n\r\n', 'utf16le')
  assert.deepEqual(parseDistroList(buf), ['Ubuntu', 'Debian'])
})

test('wslPathToUnc maps a Linux path under the distro UNC root', () => {
  assert.equal(wslPathToUnc('/home/me/x', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\home\\me\\x')
  assert.equal(wslPathToUnc('/', 'Ubuntu'), '\\\\wsl.localhost\\Ubuntu\\')
})

test('wslPathToUnc rejects Windows paths', () => {
  assert.throws(() => wslPathToUnc('C:\\Users\\me', 'Ubuntu'), /Linux 路径/)
  assert.equal(isWslLinuxPath('/home/me'), true)
  assert.equal(isWslLinuxPath('C:\\Users\\me'), false)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl.test.js`
预期：FAIL，`Cannot find module '../lib/wsl.js'`

- [ ] **步骤 3：编写最少实现代码**

```js
// lib/wsl.js — 本机 WSL 发行版接入（发现、路径映射、SFTP 适配、执行池）。
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import path from 'node:path'

export const WSL_HOST_PREFIX = 'wsl:'

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

export function isWslLinuxPath(p) {
  const s = String(p || '')
  return s.startsWith('/') && !s.startsWith('//')
}

const UNC_ROOTS = ['\\\\wsl.localhost', '\\\\wsl$']

/** Pick the first UNC namespace that this Windows build exposes. */
export function detectUncRoot(distro, deps = {}) {
  const exists = deps.exists || ((p) => existsSync(p))
  for (const base of UNC_ROOTS) {
    const root = `${base}\\${distro}`
    if (exists(root)) return root
  }
  return ''
}

export function wslPathToUnc(linuxPath, distro, uncRoot) {
  if (!isWslLinuxPath(linuxPath)) {
    throw new Error('WSL 使用 Linux 路径，例如 /home/you/project')
  }
  const root = uncRoot || detectUncRoot(distro)
  if (!root) throw new Error(`无法访问 \\\\wsl.localhost\\${distro}`)
  const rel = String(linuxPath).replace(/^\/+/, '').split('/').filter(Boolean)
  return rel.length ? root + '\\' + rel.join('\\') : root + '\\'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl.test.js`
预期：PASS（3）

- [ ] **步骤 5：Commit**

```bash
git add lib/wsl.js test/wsl.test.js
git commit -m "feat(wsl): 发行版发现与 Linux→UNC 路径映射"
```

---

### 任务 2：`WslSftp` 适配器

**文件：**
- 修改：`lib/wsl.js`
- 测试：`test/wsl-sftp.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WslSftp } from '../lib/wsl.js'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-wsl-'))
  mkdirSync(path.join(root, 'home', 'me'), { recursive: true })
  writeFileSync(path.join(root, 'home', 'me', 'a.txt'), 'hello')
  return root
}

test('readdir returns ssh2-shaped entries with mtime in seconds', async () => {
  const root = fixture()
  const sftp = new WslSftp({ distro: 'Ubuntu', uncRoot: root })
  const list = await sftp.readdir('/home/me')
  assert.equal(list.length, 1)
  assert.equal(list[0].filename, 'a.txt')
  assert.equal(list[0].attrs.isDirectory(), false)
  assert.ok(list[0].attrs.mtime > 1e9)
  assert.ok(list[0].attrs.mtime < 1e10)
  rmSync(root, { recursive: true, force: true })
})

test('readFile/writeFile round-trip and stat reports directory', async () => {
  const root = fixture()
  const sftp = new WslSftp({ distro: 'Ubuntu', uncRoot: root })
  const st = await sftp.stat('/home/me')
  assert.equal(st.isDirectory(), true)
  await sftp.writeFile('/home/me/b.txt', Buffer.from('x'))
  assert.equal(String(await sftp.readFile('/home/me/b.txt')), 'x')
  rmSync(root, { recursive: true, force: true })
})

test('readPartial reads a range without the whole file', async () => {
  const root = fixture()
  writeFileSync(path.join(root, 'home', 'me', 'big.bin'), Buffer.alloc(4096, 7))
  const sftp = new WslSftp({ distro: 'Ubuntu', uncRoot: root })
  const part = await sftp.readPartial('/home/me/big.bin', 10, 5)
  assert.equal(part.length, 5)
  assert.deepEqual([...part], [7, 7, 7, 7, 7])
  rmSync(root, { recursive: true, force: true })
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-sftp.test.js`
预期：FAIL，`WslSftp is not a constructor`

- [ ] **步骤 3：编写最少实现代码**

在 `lib/wsl.js` 追加：

```js
/** Linux path → local filesystem path, via the distro's UNC root. */
function localPathFor(linuxPath, uncRoot, distro) {
  return wslPathToUnc(linuxPath, distro, uncRoot)
}

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
 * ssh2-shaped SFTP primitives over a WSL UNC root. The callers above it
 * (buildSftpSurface → sync/search/routes/rw_*) never learn that the "remote"
 * is the local WSL filesystem.
 */
export class WslSftp extends EventEmitter {
  constructor({ distro, uncRoot, deps = {} }) {
    super()
    this.distro = distro
    this.uncRoot = uncRoot || ''
    this.fs = deps.fs || fsp
  }

  _p(linuxPath) {
    if (!this.uncRoot) this.uncRoot = detectUncRoot(this.distro)
    return localPathFor(linuxPath, this.uncRoot, this.distro)
  }

  readdir(linuxPath, cb) {
    this.fs.readdir(this._p(linuxPath), { withFileTypes: true }).then(async (entries) => {
      const out = []
      for (const e of entries) {
        const full = path.posix.join(linuxPath, e.name)
        let st
        try { st = await this.fs.lstat(this._p(full)) } catch { continue }
        out.push({ filename: e.name, longname: e.name, attrs: attrsOf(st) })
      }
      cb(null, out)
    }, (err) => cb(err))
  }

  stat(linuxPath, cb) { this.fs.stat(this._p(linuxPath)).then((st) => cb(null, attrsOf(st)), (e) => cb(e)) }
  lstat(linuxPath, cb) { this.fs.lstat(this._p(linuxPath)).then((st) => cb(null, attrsOf(st)), (e) => cb(e)) }
  mkdir(p, cb) { this.fs.mkdir(this._p(p)).then(() => cb(null), (e) => cb(e)) }
  rmdir(p, cb) { this.fs.rmdir(this._p(p)).then(() => cb(null), (e) => cb(e)) }
  unlink(p, cb) { this.fs.unlink(this._p(p)).then(() => cb(null), (e) => cb(e)) }
  rename(a, b, cb) { this.fs.rename(this._p(a), this._p(b)).then(() => cb(null), (e) => cb(e)) }
  realpath(p, cb) { this.fs.realpath(this._p(p)).then((r) => cb(null, '/' + path.relative(this.uncRoot, r).split(path.sep).join('/')), (e) => cb(e)) }
  setstat(p, attrs, cb) {
    if (attrs && typeof attrs.mode === 'number') this.fs.chmod(this._p(p), attrs.mode).then(() => cb(null), (e) => cb(e))
    else cb(null)
  }
  readFile(p, cb) { this.fs.readFile(this._p(p)).then((b) => cb(null, b), (e) => cb(e)) }
  writeFile(p, data, cb) { this.fs.writeFile(this._p(p), data).then(() => cb(null), (e) => cb(e)) }
  fastGet(p, local, cb) { this.fs.copyFile(this._p(p), local).then(() => cb(null), (e) => cb(e)) }
  fastPut(local, p, cb) { this.fs.copyFile(local, this._p(p)).then(() => cb(null), (e) => cb(e)) }

  open(linuxPath, flags, cb) {
    this.fs.open(this._p(linuxPath), flags === 'r' ? 'r' : flags).then((handle) => cb(null, handle), (e) => cb(e))
  }
  read(handle, buf, off, len, pos, cb) {
    this.fs.read(handle, buf, off, len, pos).then((r) => cb(null, r.bytesRead, buf), (e) => cb(e))
  }
  close(handle, cb) { this.fs.close(handle).then(() => cb(null), (e) => cb(e)) }
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-sftp.test.js`
预期：PASS（3）

- [ ] **步骤 5：Commit**

```bash
git add lib/wsl.js test/wsl-sftp.test.js
git commit -m "feat(wsl): 基于 Node fs 的 ssh2 形状 SFTP 适配器"
```

---

### 任务 3：`WslPool` 与执行

**文件：**
- 修改：`lib/wsl.js`
- 测试：`test/wsl-pool.test.js`

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { WslPool } from '../lib/wsl.js'

function fakeSpawn(captured) {
  return (cmd, args) => {
    const proc = new EventEmitter()
    proc.stdout = new EventEmitter()
    proc.stderr = new EventEmitter()
    proc.stdin = { write: (chunk) => captured.stdin.push(String(chunk)), end() {} }
    proc.kill = () => { captured.killed = true }
    captured.cmd = cmd
    captured.args = args
    setImmediate(() => {
      proc.stdout.emit('data', 'ok\n')
      proc.emit('close', 0)
    })
    return proc
  }
}

test('exec runs wsl.exe -d <distro> -- bash -s with the command on stdin', async () => {
  const captured = { stdin: [] }
  const pool = new WslPool({ backend: 'wsl', distro: 'Ubuntu', workspace: '/home/me/p', commandTimeoutMs: 5000 }, { spawnImpl: fakeSpawn(captured) })
  await pool.connect()
  const res = await pool.exec('echo hi', {})
  assert.equal(captured.cmd, 'wsl.exe')
  assert.deepEqual(captured.args, ['-d', 'Ubuntu', '--', 'bash', '-s'])
  assert.match(captured.stdin.join(''), /cd '\/home\/me\/p' && echo hi/)
  assert.equal(res.stdout, 'ok\n')
  assert.equal(res.code, 0)
})

test('exec rejects on timeout', async () => {
  const pool = new WslPool({ backend: 'wsl', distro: 'Ubuntu', commandTimeoutMs: 20 }, {
    spawnImpl: () => {
      const p = new EventEmitter()
      p.stdout = new EventEmitter(); p.stderr = new EventEmitter()
      p.stdin = { write() {}, end() {} }; p.kill = () => {}
      return p
    },
  })
  await pool.connect()
  await assert.rejects(() => pool.exec('sleep 1', {}), /timed out|超时/i)
})

test('shell is explicitly unsupported', async () => {
  const pool = new WslPool({ backend: 'wsl', distro: 'Ubuntu' }, { spawnImpl: fakeSpawn({ stdin: [] }) })
  await pool.connect()
  await assert.rejects(() => pool.shell({}), /终端暂不支持/)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-pool.test.js`
预期：FAIL，`WslPool is not a constructor`

- [ ] **步骤 3：编写最少实现代码**

在 `lib/wsl.js` 追加（`buildSftpSurface` 从 `./sftp-surface.js` 导入）：

```js
import { buildSftpSurface } from './sftp-surface.js'
import { shq } from './paths.js'

export class WslPool {
  constructor(config = {}, opts = {}) {
    this.config = config
    this.opts = opts
    this.distro = String(config.distro || distroOfHost(config.host) || '')
    this.spawnImpl = opts.spawnImpl || spawn
    this.client = null
    this.platform = 'linux'
    this.shellMode = 'native'
    this._uncRoot = ''
    this._sftp = null
  }

  async connect() {
    if (process.platform !== 'win32') throw new Error('仅 Windows 支持 WSL')
    if (!this.distro) throw new Error('WSL 缺少发行版名')
    const distros = await listDistros({ spawnImpl: this.spawnImpl })
    if (!distros.includes(this.distro)) throw new Error(`WSL 发行版 "${this.distro}" 不存在（wsl -l -q 中未找到）`)
    this._uncRoot = detectUncRoot(this.distro)
    if (!this._uncRoot) throw new Error(`无法访问 \\\\wsl.localhost\\${this.distro}，请确认发行版已启动（wsl -d ${this.distro} -- true）`)
    this.client = { wsl: true }
  }

  async detect() { return Promise.resolve() }

  async sftp() {
    if (!this._sftp) {
      if (!this._uncRoot) this._uncRoot = detectUncRoot(this.distro)
      this._sftp = buildSftpSurface(new WslSftp({ distro: this.distro, uncRoot: this._uncRoot }), {
        commandTimeoutMs: this.config.commandTimeoutMs || 20000,
      })
    }
    return this._sftp
  }

  exec(command, opts = {}) {
    const timeoutMs = Number(opts.timeoutMs || this.config.commandTimeoutMs || 20000)
    const cwd = String(this.config.workspace || '')
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
      try { proc.stdin.write(script + '\n'); proc.stdin.end() } catch { /* spawn already failed */ }
    })
  }

  async shell() { throw new Error('WSL 终端暂不支持（v1）') }
  invalidate() { this._sftp = null; this._uncRoot = '' }
  close() { this.client = null; this._sftp = null }
  setTarget(fields = {}) {
    if (fields.distro) this.distro = fields.distro
    if (fields.host && !fields.distro) this.distro = distroOfHost(fields.host)
    Object.assign(this.config, fields)
    this.close()
  }
}

/** Distro names as `wsl.exe -l -q` reports them; [] when WSL is unavailable. */
export async function listDistros({ spawnImpl = spawn } = {}) {
  if (process.platform !== 'win32') return []
  return new Promise((resolve) => {
    const proc = spawnImpl('wsl.exe', ['-l', '-q'], { windowsHide: true })
    const chunks = []
    proc.stdout.on('data', (d) => chunks.push(Buffer.from(d)))
    proc.on('error', () => resolve([]))
    proc.on('close', () => resolve(parseDistroList(Buffer.concat(chunks))))
  })
}

export function isWslBackend(config) {
  return !!config && config.backend === 'wsl'
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-pool.test.js`
预期：PASS（3）

- [ ] **步骤 5：Commit**

```bash
git add lib/wsl.js test/wsl-pool.test.js
git commit -m "feat(wsl): WslPool 执行、探测与 SFTP 挂载"
```

---

### 任务 4：连接工厂与 ActivePool 分派

**文件：**
- 修改：`lib/pool.js`（`createPool`、`ActivePool`）
- 测试：`test/wsl-pool.test.js`（追加）

- [ ] **步骤 1：编写失败的测试**

```js
test('createPool returns WslPool for backend wsl and ActivePool swaps delegates', async () => {
  const { createPool, ActivePool } = await import('../lib/pool.js')
  const pool = createPool({ backend: 'wsl', distro: 'Ubuntu', host: 'wsl:Ubuntu' }, { spawnImpl: fakeSpawn({ stdin: [] }) })
  assert.equal(pool.constructor.name, 'WslPool')

  const active = new ActivePool({ backend: 'native', host: 'h', port: 22, username: 'u' }, {})
  assert.notEqual(active._delegate.constructor.name, 'WslPool')
  active.setTarget({ host: 'wsl:Ubuntu', port: 0, username: '', backend: 'wsl', distro: 'Ubuntu' })
  assert.equal(active._delegate.constructor.name, 'WslPool')
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-pool.test.js`
预期：FAIL，`createPool` 返回 `SshPool` 或 `setTarget` 后仍是 `SshPool`

- [ ] **步骤 3：编写最少实现代码**

`lib/pool.js`：

```js
import { WslPool, isWslBackend } from './wsl.js'

export function createPool(config, opts) {
  if (isWslBackend(config)) return new WslPool(config, opts)
  return isSystemOpenSshBackend(config)
    ? new SystemOpenSshPool(config, opts)
    : new SshPool(config, opts)
}
```

`ActivePool` 增加：

```js
  _wantsWsl() { return isWslBackend(this.config) }
  _delegateIsCurrent() {
    if (!this._delegate) return false
    if (this._wantsWsl()) return this._delegate instanceof WslPool
    if (this._delegate instanceof WslPool) return false
    const isOpenssh = this._delegate instanceof SystemOpenSshPool
    return isOpenssh === this._wantsSystemOpenSsh()
  }
```

`setTarget(fields, previous)` 的 diff 列表增加 `backend`、`distro`（与现有 `host/port/username` 同组）。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-pool.test.js`
预期：PASS（追加 1 条，共 4）

- [ ] **步骤 5：Commit**

```bash
git add lib/pool.js test/wsl-pool.test.js
git commit -m "feat(wsl): pool 工厂与 ActivePool 分派 wsl 后端"
```

---

### 任务 5：身份、注册表与镜像标记

**文件：**
- 修改：`lib/index.js`（`withSshConfig`、`ensureMirror`、`machinesForClient`、`identityOf`）
- 修改：`lib/registry.js`（`applyMachine`）
- 测试：`test/wsl-identity.test.js`（新）

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyMachine } from '../lib/registry.js'

test('applyMachine switches config to the wsl backend and records the distro', () => {
  const config = { backend: 'native', host: '', port: 22, username: '' }
  applyMachine(config, { kind: 'wsl', host: 'wsl:Ubuntu', port: 0, username: '' })
  assert.equal(config.backend, 'wsl')
  assert.equal(config.distro, 'Ubuntu')
  assert.equal(config.host, 'wsl:Ubuntu')
})

test('applyMachine leaves ssh machines untouched', () => {
  const config = { backend: 'native', host: '', port: 22, username: '' }
  applyMachine(config, { host: 'box', port: 2222, username: 'me' })
  assert.equal(config.backend, 'native')
  assert.equal(config.distro, undefined)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-identity.test.js`
预期：FAIL，`config.backend` 仍是 `native`

- [ ] **步骤 3：编写最少实现代码**

`lib/registry.js` 的 `applyMachine` 开头（在赋值 host 之前）：

```js
  if (m.kind === 'wsl') {
    config.backend = 'wsl'
    config.distro = String(m.host || '').replace(/^wsl:/, '')
  } else if (m.backend) {
    config.backend = m.backend
  }
```

并删除后面重复的 `if (m.backend) config.backend = m.backend`（或改为 `else if`）。

`lib/index.js`：

```js
  const withSshConfig = (m) => {
    if (m && m.kind === 'wsl') {
      return { ...m, sshConfigMatched: false, sshConfigWarnings: [], port: 0, username: '' }
    }
    // ...原逻辑
  }
```

`ensureMirror(remotePath, host, user, port, extra = {})` 的 meta：

```js
  const meta = { host, port, username: user, remotePath: normalizeRemotePath(remotePath), createdAt: new Date().toISOString() }
  if (extra.kind) meta.kind = String(extra.kind)
```

`ensureMirror(...)` 的三处调用点都要把机器 kind 带进 meta：

- `lib/index.js:2192`（`rw_pick_workspace`）：
  `const local = ensureMirror(p, b.host, b.username, b.port, { alias: b.alias || "", kind: rec && rec.kind })`
  （`rec` 为该 binding 对应的注册表记录；取不到时省略。）
- `lib/index.js:3514` 与 `3542`（`/mirror` 路由）：
  `const local = ensureMirror(p, config.host, config.username, config.port, { alias: aliasOf(activeMachine()), kind: (activeMachine() || {}).kind })`

`machinesForClient()`：

```js
  const machinesForClient = () => machines.map((m) => ({
    ...sanitizeMachine(m),
    kind: m.kind || 'ssh',
    wslDistro: m.kind === 'wsl' ? String(m.host || '').replace(/^wsl:/, '') : undefined,
    sshConfigResolved: m.kind === 'wsl' ? null
      : (m.useSshConfig
          ? resolveMachineSshConfig(m, { text: sshConfigText() })
          : resolveLiteralSshConfig(m, { text: sshConfigText() })),
    connected: isMachineLive(m),
  }))
```

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-identity.test.js`
预期：PASS（2）；再跑 `test/binding.test.js`、`test/apply-active-machine.test.js` 确认未破坏。

- [ ] **步骤 5：Commit**

```bash
git add lib/index.js lib/registry.js test/wsl-identity.test.js
git commit -m "feat(wsl): 机器身份与镜像元数据记录 kind"
```

---

### 任务 6：`/dsh-remote/wsl` 与 `from-wsl`

**文件：**
- 修改：`lib/wsl.js`（新增 `describeWsl()`）
- 修改：`lib/index.js`（routes 数组，`/dsh-remote/machines` 的 POST 分支）
- 测试：`test/wsl-routes.test.js`（新）

- [ ] **步骤 1：编写失败的测试**

用现有 `test/harness/plugin-host.js` 的 `createHost`（真实路由表 + 隔离 `DSH_HOME`）。`/wsl` 的发行版探测抽成 `describeWsl()` 纯函数，避免测试去调用真 `wsl.exe`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHost } from './harness/plugin-host.js'
import { describeWsl } from '../lib/wsl.js'

test('describeWsl marks the first distro as default and reports UNC roots', async () => {
  const out = await describeWsl({
    platform: 'win32',
    listDistrosImpl: async () => ['Ubuntu', 'Debian'],
    detectRoot: (name) => `\\\\wsl.localhost\\${name}`,
  })
  assert.equal(out.available, true)
  assert.deepEqual(out.distros.map((d) => d.name), ['Ubuntu', 'Debian'])
  assert.equal(out.distros[0].default, true)
  assert.equal(out.distros[1].default, false)
})

test('describeWsl hides itself off Windows or without distros', async () => {
  assert.equal((await describeWsl({ platform: 'linux' })).available, false)
  const none = await describeWsl({ platform: 'win32', listDistrosImpl: async () => [], detectRoot: () => '' })
  assert.equal(none.available, false)
  assert.match(none.reason, /wsl --install/)
})

test('from-wsl is idempotent and records kind=wsl', async () => {
  const host = await createHost()
  try {
    const first = await host.call('/dsh-remote/machines', { method: 'POST', body: { action: 'from-wsl', distro: 'Ubuntu' } })
    assert.equal(first.json.ok, true)
    const second = await host.call('/dsh-remote/machines', { method: 'POST', body: { action: 'from-wsl', distro: 'Ubuntu' } })
    assert.equal(second.json.ok, true)
    const saved = host.readMachines().filter((m) => m.kind === 'wsl')
    assert.equal(saved.length, 1)
    assert.equal(saved[0].host, 'wsl:Ubuntu')
    assert.equal(saved[0].port, 0)
  } finally {
    await host.dispose()
  }
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-routes.test.js`
预期：FAIL，找不到 `/dsh-remote/wsl`

- [ ] **步骤 3：编写最少实现代码**

`lib/wsl.js` 追加：

```js
/** The payload behind GET /dsh-remote/wsl; pure enough to unit-test. */
export async function describeWsl({ listDistrosImpl = listDistros, detectRoot = detectUncRoot, platform = process.platform } = {}) {
  if (platform !== 'win32') return { available: false, reason: '仅 Windows 支持 WSL', distros: [] }
  try {
    const names = await listDistrosImpl()
    if (!names.length) return { available: false, reason: '没有找到 WSL 发行版（可运行 wsl --install）', distros: [] }
    return {
      available: true,
      distros: names.map((name, i) => ({ name, default: i === 0, uncRoot: detectRoot(name) || '' })),
    }
  } catch (err) {
    return { available: false, reason: String((err && err.message) || err), distros: [] }
  }
}
```

`lib/index.js` routes 数组追加：

```js
    {
      kind: 'exact',
      path: '/dsh-remote/wsl',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        return sendJson(res, 200, await describeWsl())
      },
    },
```

`/dsh-remote/machines` POST 的 `action` 分支（`if (action === 'add' || action === 'update')` 之前）：

```js
            if (action === 'from-wsl') {
              const distro = String(body.distro || '').trim()
              if (!distro) return sendJson(res, 400, { ok: false, error: 'distro required' })
              const host = wslHostFor(distro)
              const existing = machines.find((m) => m.kind === 'wsl' && m.host === host)
              if (existing) return sendJson(res, 200, { ok: true, machine: sanitizeMachine(existing), machines: machinesForClient() })
              const rec = {
                id: machineId(),
                kind: 'wsl',
                name: distro,
                host,
                port: 0,
                username: '',
                password: '',
                privateKeyPath: '',
                passphrase: '',
                workspace: '',
                backend: 'wsl',
                credentialBackend: 'plain',
                recentWorkspaces: [],
              }
              machines.push(rec)
              saveMachines(machines, store.currentId, false)
              return sendJson(res, 200, { ok: true, machine: sanitizeMachine(rec), machines: machinesForClient() })
            }
```

导入：`import { listDistros, detectUncRoot, wslHostFor } from './wsl.js'`。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-routes.test.js`
预期：PASS（2）

- [ ] **步骤 5：Commit**

```bash
git add lib/index.js test/wsl-routes.test.js
git commit -m "feat(wsl): /wsl 发现路由与 from-wsl 幂等添加"
```

---

### 任务 7：设置页「本机 WSL」卡片与机器行

**文件：**
- 修改：`lib/client.js`（`RemoteWorkspacePage` 的状态与渲染、机器行、表单）
- 测试：`test/wsl-ui.test.js`（新）

- [ ] **步骤 1：编写失败的测试**

用 `test/harness/render.js` 的 `mountClient`：

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

test('settings page renders the WSL card when /dsh-remote/wsl is available', async () => {
  const ui = mountClient({
    fetch: async (url) => {
      if (String(url).includes('/dsh-remote/wsl')) {
        return { ok: true, status: 200, json: async () => ({ available: true, distros: [{ name: 'Ubuntu', default: true, uncRoot: '\\\\wsl.localhost\\Ubuntu' }] }) }
      }
      return { ok: true, status: 200, json: async () => ({}) }
    },
  })
  const tree = await ui.settle()
  assert.match(ui.text(tree), /本机 WSL/)
  assert.match(ui.text(tree), /Ubuntu/)
  ui.dispose()
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-ui.test.js`
预期：FAIL，文本中没有「本机 WSL」

- [ ] **步骤 3：编写最少实现代码**

在 `RemoteWorkspacePage` 内新增状态与加载：

```js
      const [wsl, setWsl] = React.useState({ available: false, distros: [] })
      const loadWsl = () => api('GET', '/dsh-remote/wsl')
        .then((r) => setWsl({ available: !!r.available, distros: r.distros || [] }))
        .catch(() => setWsl({ available: false, distros: [] }))
      React.useEffect(() => { loadWsl() }, [])
```

渲染（放在 `settings.pickHost` 卡片之前）：

```js
        wsl.available ? React.createElement('div', { style: boxS },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 } },
            React.createElement('div', { style: { fontSize: 13, fontWeight: 600 } }, tr('settings.wslTitle')),
            React.createElement('button', {
              type: 'button', className: 'dsh-rw-btn',
              style: { ...buttonS, fontSize: 11, padding: '2px 8px', marginLeft: 'auto' },
              onClick: loadWsl,
            }, tr('settings.wslRefresh'))),
          ...wsl.distros.map((d) => React.createElement('div', {
            key: d.name,
            style: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', fontSize: 12 },
          },
            React.createElement('span', { style: { fontWeight: 600 } }, d.name),
            d.default ? pill('is-ok', tr('settings.wslDefault')) : null,
            React.createElement('span', { style: { opacity: 0.6, marginLeft: 'auto' } }, d.uncRoot || ''),
            React.createElement('button', {
              type: 'button', className: 'dsh-rw-btn',
              style: { ...buttonS, fontSize: 11, padding: '2px 8px' },
              onClick: () => api('POST', '/dsh-remote/machines', { action: 'from-wsl', distro: d.name })
                .then(refresh).then(() => setMsg(tr('settings.wslAdded', { distro: d.name })))
                .catch((e) => setErr(String((e && e.message) || e))),
            }, tr('settings.wslAdd')),
          )),
        ) : null,
```

机器行与表单（`lib/client.js`）：

```js
      // 机器行的名称旁（`sortedMachines.map` 的行渲染里，名称 span 之后）：
      m.kind === 'wsl'
        ? React.createElement('span', {
            style: { fontSize: 10, padding: '1px 5px', borderRadius: 4, background: '#8883', opacity: 0.8 },
          }, 'WSL')
        : null,
```

编辑表单对 WSL 机器隐藏 SSH 字段。在表单渲染函数内、`row(...)` 定义之后加一个包装：

```js
      const isWsl = form.kind === 'wsl'
      const rowUnlessWsl = (...args) => (isWsl ? null : row(...args))
```

然后把下列现有调用从 `row(` 改成 `rowUnlessWsl(`（保持其余参数不变）：

`settings.host`、`settings.port`、`settings.user`、`settings.password`、`settings.privateKey`、`settings.passphrase`、`settings.proxyHost`、`settings.proxyPortUser`、`settings.proxyKey`、`settings.backend`、`settings.sshBinary`、`settings.hostKeyMode`、`settings.agent`、`settings.keyboardInteractive`、`settings.encryptPassword`。

WSL 机器保留：名称、默认工作区、保存、删除、取消编辑。

新增 i18n key（zh + en 各一份）：`settings.wslTitle`（本机 WSL / Local WSL）、`settings.wslRefresh`（刷新 / Refresh）、`settings.wslDefault`（默认 / default）、`settings.wslAdd`（添加 / Add）、`settings.wslAdded`（已添加 WSL 机器：{distro} / Added WSL machine: {distro}）、`settings.wslUnsupported`（WSL 暂不支持此功能 / Not supported on WSL yet）。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-ui.test.js`
预期：PASS（1）；再跑 `test/client-smoke.test.js`、`test/i18n-keys.test.js`。

- [ ] **步骤 5：Commit**

```bash
git add lib/client.js test/wsl-ui.test.js
git commit -m "feat(wsl): 设置页本机 WSL 卡片与机器行标记"
```

---

### 任务 8：选择器文案与能力边界

**文件：**
- 修改：`lib/client.js`（DirPicker 下拉、端口转发/部署/远端界面区块）
- 修改：`lib/routes-term.js` 或 `lib/remote-shell.js`（终端拒绝）
- 测试：`test/wsl-capability.test.js`（新）

- [ ] **步骤 1：编写失败的测试**

```js
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertTerminalSupported, assertRemoteCapability } from '../lib/wsl.js'

const here = path.dirname(fileURLToPath(import.meta.url))

/** Evaluate lib/client.js (classic script) and reach its __test hook. */
function clientTestHook() {
  const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')
  let loaded = null
  const React = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const win = { addEventListener() {}, localStorage: { getItem: () => null, setItem() {} }, location: { protocol: 'http:' }, __ModuleLoader__: { load: (m) => { loaded = m } } }
  const doc = { head: { appendChild() {} }, createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, innerHTML: '' }), getElementById: () => null }
  const requireStub = (id) => (id === 'react' ? React : { relativeTime: () => ({ unit: 'now', n: 0 }) })
  new Function('window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'fetch', 'require', src)(
    win, doc, { languages: ['zh-CN'] }, setTimeout, clearTimeout, setInterval, clearInterval, console, async () => ({}), requireStub,
  )
  return loaded.factory(requireStub).__test
}

test('DirPicker labels WSL machines as WSL', () => {
  const { wslMachineLabel } = clientTestHook()
  assert.equal(wslMachineLabel({ kind: 'wsl', name: 'Ubuntu', host: 'wsl:Ubuntu', username: '' }), 'Ubuntu（WSL）')
  assert.equal(wslMachineLabel({ kind: 'ssh', name: 'box', host: '10.0.0.7', username: 'me' }), 'box (me@10.0.0.7)')
})

test('terminal refuses a WSL binding', () => {
  assert.throws(() => assertTerminalSupported({ host: 'wsl:Ubuntu' }), /终端暂不支持/)
  assert.doesNotThrow(() => assertTerminalSupported({ host: '10.0.0.7' }))
})

test('deploy and forward refuse WSL machines', () => {
  assert.equal(assertRemoteCapability({ host: 'wsl:Ubuntu' }, 'deploy').ok, false)
  assert.equal(assertRemoteCapability({ host: 'wsl:Ubuntu' }, 'forward').ok, false)
  assert.equal(assertRemoteCapability({ host: '10.0.0.7' }, 'deploy').ok, true)
})
```

- [ ] **步骤 2：运行测试验证失败**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-capability.test.js`
预期：FAIL，函数不存在

- [ ] **步骤 3：编写最少实现代码**

`lib/wsl.js`：

```js
export function assertTerminalSupported(target) {
  const host = typeof target === 'string' ? target : (target && target.host)
  if (isWslHost(host)) throw new Error('WSL 终端暂不支持（v1）')
}

export function assertRemoteCapability(machine, capability) {
  const host = typeof machine === 'string' ? machine : (machine && machine.host)
  if (!isWslHost(host)) return { ok: true }
  const label = capability === 'deploy' ? '部署' : capability === 'forward' ? '端口转发' : capability
  return { ok: false, error: `WSL 暂不支持${label}` }
}
```

`lib/routes-term.js` 的 `/term/open`：在 `const bound = await bind(req, res, body); if (!bound) return` 之后加：

```js
          try { assertTerminalSupported(bound.b.machine) } catch (err) {
            return sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
          }
```

（`bound.b.machine` 就是 `resolveRequestBinding` 解析出的远端身份，`host` 为 `wsl:<发行版>`。）

`lib/index.js` 的能力拒绝：

- `/dsh-remote/forwards` handler 开头：
  `const cap = assertRemoteCapability(activeMachine(), 'forward'); if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error })`
- `/dsh-remote/web-attach` handler 开头：
  `const cap = assertRemoteCapability(activeMachine(), 'deploy'); if (!cap.ok) return sendJson(res, 400, { ok: false, error: cap.error })`
- `rw_deploy_probe` 工具：`const b = requireBinding(exec, 'rw_deploy_probe')` 之后：
  `const cap = assertRemoteCapability({ host: b.host }, 'deploy'); if (!cap.ok) throw new Error(cap.error)`

`lib/client.js`：

```js
    function wslMachineLabel(m) {
      const name = m.name || String(m.host || '').replace(/^wsl:/, '')
      return m.kind === 'wsl' ? `${name}（WSL）` : `${name} (${m.username}@${m.host})`
    }
```

用于 DirPicker 的两处机器 `<option>` 文案（约 1823、1847 行），并把 `wslMachineLabel` 加进 `exports.__test`：

```js
    exports.__test = { patchSettingsNavIcon, installSettingsNavIcon, SERVER_NAV_ICON, wslMachineLabel }
```

设置页面板：当 `form.kind === 'wsl'` 或当前机器是 WSL 时，端口转发区块替换为 `tr('settings.wslUnsupported')` 提示，部署/远端界面区块不渲染。

- [ ] **步骤 4：运行测试验证通过**

运行：`node --import ./test/setup-telemetry-off.mjs test/wsl-capability.test.js`
预期：PASS（3）

- [ ] **步骤 5：Commit**

```bash
git add lib/client.js lib/routes-term.js lib/wsl.js test/wsl-capability.test.js
git commit -m "feat(wsl): 选择器文案与终端/部署/转发能力边界"
```

---

### 任务 9：文档、CHANGELOG 与版本

**文件：**
- 修改：`README.md`、`README.en.md`
- 修改：`CHANGELOG.md`
- 修改：`package.json`
- 修改：`docs/superpowers/specs/2026-10-30-wsl-workspace-design.md`（版本号若与规格不同）

- [ ] **步骤 1：更新 README**

在「功能」一节后新增小节：

```markdown
### 本机 WSL（0.8.66+）

Windows 上可把本机 WSL 发行版直接当远程工作区：设置 → 远程工作区 → 「本机 WSL」→ 添加，
然后照常选目录、建镜像、用 `rw_*` 工具与 `rw_exec`。不需要在 WSL 里安装 sshd。

v1 限制：终端、端口转发、一键部署、远端 DSH 界面暂不支持。
```

英文 README 对应翻译。

- [ ] **步骤 2：写 CHANGELOG**

```markdown
## 0.8.66 — 2026-10-30
### 本机 WSL 工作区 + 设置项改名与图标

- **WSL 作为第三种接入后端**：Windows 上的设置页新增「本机 WSL」卡片，自动列出发行版，
  一键添加为机器；文件走 `\\wsl.localhost\<发行版>`，命令走 `wsl.exe -d <发行版>`，
  镜像/同步/搜索/22 个 `rw_*` 工具透明复用。v1 不做终端、端口转发、部署与远端界面。
- 设置项名称由「远程工作区（dsh-remote）」改为「远程工作区」，导航图标由通用齿轮
  换成服务器线性图标。
- 测试：新增 `test/wsl.test.js`、`test/wsl-sftp.test.js`、`test/wsl-pool.test.js`、`test/wsl-identity.test.js`、`test/wsl-routes.test.js`、`test/wsl-ui.test.js`、`test/wsl-capability.test.js`（见任务 1-8）。
```

- [ ] **步骤 3：提升版本**

`package.json` 的 `version` 改为 `0.8.66`（`package-lock.json` 同步）。

- [ ] **步骤 4：运行相关测试**

```bash
node --import ./test/setup-telemetry-off.mjs test/wsl.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-sftp.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-pool.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-identity.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-routes.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-ui.test.js
node --import ./test/setup-telemetry-off.mjs test/wsl-capability.test.js
node --import ./test/setup-telemetry-off.mjs test/settings-nav-icon.test.js
```
预期：全部 PASS。

- [ ] **步骤 5：Commit**

```bash
git add README.md README.en.md CHANGELOG.md package.json package-lock.json
git commit -m "docs(0.8.66): WSL 工作区、设置项改名与图标"
```

---

## 完成标准

- `git status` 干净；所有任务提交。
- 上述测试文件全部通过；`lib/client.js`、`lib/index.js`、`lib/wsl.js` `node --check` 通过。
- 真实 Windows + WSL 人工验证：添加 Ubuntu → 选 `/home/<user>/...` → 镜像 → `rw_read_file` → `rw_exec` → `rw_sync`；终端/部署/转发入口显示明确提示。
