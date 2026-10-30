// WSL discovery + the `from-wsl` adoption action. The distro probe is a pure
// function so these tests never call the real wsl.exe; adoption is exercised
// through the real route table and an isolated DSH_HOME.
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
  assert.equal(out.distros[0].uncRoot, '\\\\wsl.localhost\\Ubuntu')
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
    assert.equal(saved[0].backend, 'wsl')
  } finally {
    await host.dispose()
  }
})

test('GET /dsh-remote/wsl is available off-Windows without throwing', async () => {
  const host = await createHost()
  try {
    const r = await host.call('/dsh-remote/wsl', { method: 'GET' })
    assert.equal(r.status, 200)
    assert.equal(typeof r.json.available, 'boolean')
    assert.ok(Array.isArray(r.json.distros))
  } finally {
    await host.dispose()
  }
})
