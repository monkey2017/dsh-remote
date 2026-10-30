// A WSL machine is an ordinary registry record plus `kind:"wsl"`. The live
// config must follow it into the wsl backend while ordinary SSH records keep
// exactly their old behaviour.
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
  assert.equal(config.host, 'box')
  assert.equal(config.port, 2222)
})
