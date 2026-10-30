// The settings page grows a 「本机 WSL」 card when the host reports available
// distros. This is the only new entry point users see, so it is pinned against
// the real rendered tree (harness = mountClient).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mountClient } from './harness/render.js'

test('settings page renders the WSL card when /dsh-remote/wsl is available', async () => {
  const ui = mountClient({
    fetch: async (url) => {
      const u = String(url)
      if (u.includes('/dsh-remote/wsl')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ available: true, distros: [{ name: 'Ubuntu', default: true, uncRoot: '\\\\wsl.localhost\\Ubuntu' }] }),
        }
      }
      return { ok: true, status: 200, json: async () => ({ machines: [], currentId: '' }) }
    },
  })
  try {
    const tree = await ui.settle()
    assert.match(ui.text(tree), /本机 WSL/)
    assert.match(ui.text(tree), /Ubuntu/)
  } finally {
    ui.dispose()
  }
})

test('settings page hides the WSL card when the host has no WSL', async () => {
  const ui = mountClient({
    fetch: async (url) => {
      const u = String(url)
      if (u.includes('/dsh-remote/wsl')) {
        return { ok: true, status: 200, json: async () => ({ available: false, reason: '仅 Windows 支持 WSL', distros: [] }) }
      }
      return { ok: true, status: 200, json: async () => ({ machines: [], currentId: '' }) }
    },
  })
  try {
    const tree = await ui.settle()
    assert.doesNotMatch(ui.text(tree), /本机 WSL/)
  } finally {
    ui.dispose()
  }
})
