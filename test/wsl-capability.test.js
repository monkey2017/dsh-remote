// v1 WSL supports the workspace/file/exec loop only. Every other surface must
// fail clearly (and the picker must label the machine as WSL, not as an empty
// SSH identity).
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
  const win = {
    addEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { protocol: 'http:' },
    __ModuleLoader__: { load: (m) => { loaded = m } },
  }
  const doc = {
    head: { appendChild() {} },
    createElement: () => ({ style: {}, setAttribute() {}, appendChild() {}, innerHTML: '' }),
    getElementById: () => null,
  }
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
