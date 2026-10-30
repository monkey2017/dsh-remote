// WSL discovery and path mapping: the two pure pieces that decide whether the
// rest of the backend can even start. Kept dependency-free so they can run on
// any platform (the Windows-only checks live in WslPool).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseDistroList, wslPathToUnc, detectUncRoot, isWslLinuxPath } from '../lib/wsl.js'

test('parseDistroList decodes UTF-16LE and drops blank lines', () => {
  const buf = Buffer.from('\uFEFFUbuntu\r\nDebian\r\n\r\n', 'utf16le')
  assert.deepEqual(parseDistroList(buf), ['Ubuntu', 'Debian'])
})

test('wslPathToUnc maps a Linux path under the distro UNC root', () => {
  const root = '\\\\wsl.localhost\\Ubuntu'
  assert.equal(wslPathToUnc('/home/me/x', 'Ubuntu', root), '\\\\wsl.localhost\\Ubuntu\\home\\me\\x')
  assert.equal(wslPathToUnc('/', 'Ubuntu', root), '\\\\wsl.localhost\\Ubuntu\\')
  assert.equal(wslPathToUnc('/home/me/../you', 'Ubuntu', root), '\\\\wsl.localhost\\Ubuntu\\home\\me\\..\\you')
})

test('wslPathToUnc rejects Windows paths', () => {
  assert.throws(() => wslPathToUnc('C:\\Users\\me', 'Ubuntu', '\\\\wsl.localhost\\Ubuntu'), /Linux 路径/)
  assert.equal(isWslLinuxPath('/home/me'), true)
  assert.equal(isWslLinuxPath('C:\\Users\\me'), false)
})

test('detectUncRoot falls back from wsl.localhost to wsl$', () => {
  const root = detectUncRoot('Ubuntu', { exists: (p) => p === '\\\\wsl$\\Ubuntu' })
  assert.equal(root, '\\\\wsl$\\Ubuntu')
  assert.equal(detectUncRoot('Ubuntu', { exists: () => false }), '')
})
