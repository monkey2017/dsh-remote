// The WSL SFTP adapter must present exactly the ssh2 shape buildSftpSurface()
// (and therefore sync/search/routes/rw_*) consumes. A temp directory stands in
// for the distro's UNC root so these tests run anywhere.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { WslSftp } from '../lib/wsl.js'
import { buildSftpSurface } from '../lib/sftp-surface.js'

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-wsl-'))
  mkdirSync(path.join(root, 'home', 'me'), { recursive: true })
  writeFileSync(path.join(root, 'home', 'me', 'a.txt'), 'hello')
  return root
}

function surfaceFor(root) {
  return buildSftpSurface(new WslSftp({ distro: 'Ubuntu', uncRoot: root }), { commandTimeoutMs: 5000 })
}

test('readdir returns ssh2-shaped entries with mtime in seconds', async () => {
  const root = fixture()
  try {
    const list = await surfaceFor(root).readdir('/home/me')
    assert.equal(list.length, 1)
    assert.equal(list[0].filename, 'a.txt')
    assert.equal(list[0].attrs.isDirectory(), false)
    assert.ok(list[0].attrs.mtime > 1e9, 'mtime must be seconds, not milliseconds')
    assert.ok(list[0].attrs.mtime < 1e10)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('stat reports a directory and read/write round-trips', async () => {
  const root = fixture()
  try {
    const sftp = surfaceFor(root)
    const st = await sftp.stat('/home/me')
    assert.equal(st.isDirectory(), true)
    await sftp.writeFile('/home/me/b.txt', Buffer.from('x'))
    assert.equal(String(await sftp.readFile('/home/me/b.txt')), 'x')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('readPartial reads a range without the whole file', async () => {
  const root = fixture()
  try {
    writeFileSync(path.join(root, 'home', 'me', 'big.bin'), Buffer.alloc(4096, 7))
    const part = await surfaceFor(root).readPartial('/home/me/big.bin', 10, 5)
    assert.equal(part.length, 5)
    assert.deepEqual([...part], [7, 7, 7, 7, 7])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('mkdir/rename/unlink/rmdir work through the adapter', async () => {
  const root = fixture()
  try {
    const sftp = surfaceFor(root)
    await sftp.mkdir('/home/me/sub')
    await sftp.rename('/home/me/a.txt', '/home/me/sub/a.txt')
    assert.equal(String(await sftp.readFile('/home/me/sub/a.txt')), 'hello')
    await sftp.unlink('/home/me/sub/a.txt')
    await sftp.rmdir('/home/me/sub')
    await assert.rejects(() => sftp.stat('/home/me/sub'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
