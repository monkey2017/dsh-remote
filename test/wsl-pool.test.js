// WslPool is the transport seam: it must spawn `wsl.exe` with the distro, feed
// the script through stdin (no shell quoting on the Windows side), honour the
// per-command timeout, and refuse what v1 does not support.
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

function poolWith(spawnImpl, extra = {}) {
  return new WslPool(
    { backend: 'wsl', distro: 'Ubuntu', workspace: '/home/me/p', commandTimeoutMs: 5000, ...extra },
    {
      spawnImpl,
      listDistrosImpl: async () => ['Ubuntu'],
      detectRoot: () => '\\\\wsl.localhost\\Ubuntu',
      platform: 'win32',
    },
  )
}

test('exec runs wsl.exe -d <distro> -- bash -s with the command on stdin', async () => {
  const captured = { stdin: [] }
  const pool = poolWith(fakeSpawn(captured))
  await pool.connect()
  const res = await pool.exec('echo hi', {})
  assert.equal(captured.cmd, 'wsl.exe')
  assert.deepEqual(captured.args, ['-d', 'Ubuntu', '--', 'bash', '-s'])
  assert.match(captured.stdin.join(''), /cd '\/home\/me\/p' && echo hi/)
  assert.equal(res.stdout, 'ok\n')
  assert.equal(res.code, 0)
})

test('exec rejects on timeout and kills the process', async () => {
  const captured = { stdin: [] }
  const pool = new WslPool(
    { backend: 'wsl', distro: 'Ubuntu', commandTimeoutMs: 20 },
    {
      spawnImpl: () => {
        const p = new EventEmitter()
        p.stdout = new EventEmitter()
        p.stderr = new EventEmitter()
        p.stdin = { write() {}, end() {} }
        p.kill = () => { captured.killed = true }
        return p
      },
      listDistrosImpl: async () => ['Ubuntu'],
      detectRoot: () => '\\\\wsl.localhost\\Ubuntu',
      platform: 'win32',
    },
  )
  await pool.connect()
  await assert.rejects(() => pool.exec('sleep 1', {}), /timed out|超时/i)
  assert.equal(captured.killed, true)
})

test('connect rejects an unknown distro', async () => {
  const pool = new WslPool({ backend: 'wsl', distro: 'Nope' }, {
    spawnImpl: fakeSpawn({ stdin: [] }),
    listDistrosImpl: async () => ['Ubuntu'],
    detectRoot: () => '\\\\wsl.localhost\\Nope',
    platform: 'win32',
  })
  await assert.rejects(() => pool.connect(), /不存在/)
})

test('shell is explicitly unsupported', async () => {
  const pool = poolWith(fakeSpawn({ stdin: [] }))
  await pool.connect()
  await assert.rejects(() => pool.shell({}), /终端暂不支持/)
})

test('detect reports a Linux platform without touching Git Bash', async () => {
  const pool = poolWith(fakeSpawn({ stdin: [] }))
  await pool.connect()
  await pool.detect()
  assert.equal(pool.platform, 'linux')
  assert.equal(pool.shellMode, 'native')
})
