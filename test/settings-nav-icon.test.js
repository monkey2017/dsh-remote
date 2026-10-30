// The settings nav row for dsh-remote is rendered by DSH's own ui-settings
// shell, which picks the icon from a hardcoded id map (`navIcon(id)`) and falls
// back to the gear used by General settings. There is no icon option on
// `settings.section`, so the only way to give this plugin its own glyph is a
// small DOM post-pass. These tests pin the two things that can break without
// anyone noticing: the nav label must stay short enough for the 188px rail, and
// the post-pass must replace the gear without touching any other nav row.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', 'lib', 'client.js'), 'utf8')

/** Minimal React stand-in: the factory only defines components here. */
const React = {
  createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
  useState: (v) => [typeof v === 'function' ? v() : v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useMemo: (fn) => fn(),
  useCallback: (fn) => fn,
  Fragment: 'Fragment',
}

function fakeElement(tag) {
  return {
    tagName: tag,
    style: {},
    attrs: {},
    innerHTML: '',
    textContent: '',
    children: [],
    setAttribute(k, v) { this.attrs[k] = String(v) },
    remove() {},
    appendChild(child) { this.children.push(child); return child },
  }
}

/**
 * Load lib/client.js the way the web client does (classic script + module
 * loader), return the module exports and the i18n dictionaries it registered.
 */
function loadClient({ withBody = false } = {}) {
  let loaded = null
  const dicts = {}
  const win = {
    addEventListener() {},
    removeEventListener() {},
    localStorage: { getItem: () => null, setItem() {} },
    location: { protocol: 'http:', href: 'http://127.0.0.1/' },
    __ModuleLoader__: { load: (m) => { loaded = m } },
  }
  const doc = {
    head: { appendChild() {} },
    body: withBody ? { observeTarget: true } : undefined,
    createElement: (tag) => fakeElement(tag),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
  }
  const requireStub = (id) => {
    if (id === 'react') return React
    if (id === '@deepseek-ai/dsh-client-ui-primitives') return { relativeTime: () => ({ unit: 'now', n: 0 }) }
    throw new Error('unexpected require: ' + id)
  }
  const run = new Function(
    'window', 'document', 'navigator', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'console', 'fetch', 'require',
    src,
  )
  run(win, doc, { clipboard: null, userAgent: 'node', languages: ['zh-CN'] }, setTimeout, clearTimeout, setInterval, clearInterval, console, async () => ({ ok: true, json: async () => ({}) }), requireStub)

  const mod = loaded.factory(requireStub)
  const ctx = {
    get(name) {
      if (name === 'locale') {
        return {
          register: (ns, registered) => { Object.assign(dicts, registered) },
          bind: () => (k) => k,
        }
      }
      if (name === 'slots') {
        return { inject: (slot, fn) => { fn(); return () => {} }, register: () => () => {}, get: () => [] }
      }
      if (name === 'sessions') return { list: { getSnapshot: () => ({ byId: {} }) } }
      return undefined
    },
    effect(fn) { const d = fn(); return typeof d === 'function' ? d : () => {} },
    inject(names, cb) { if (names.every((n) => this.get(n) !== undefined)) cb(this) },
    on() {},
    logger: { warn() {}, info() {}, debug() {} },
  }
  mod.apply(ctx)
  return { mod, dicts, win, doc }
}

/** A settings nav button shaped like the shell's: [svg, span(label)]. */
function fakeNavButton(label) {
  const svg = {
    tagName: 'svg',
    style: {},
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v) },
    remove() {},
  }
  const span = { tagName: 'span', style: {}, attrs: {}, textContent: label, setAttribute() {}, remove() {} }
  const button = {
    tagName: 'button',
    style: {},
    attrs: {},
    children: [svg, span],
    get firstChild() { return this.children[0] || null },
    setAttribute(k, v) { this.attrs[k] = String(v) },
    insertBefore(child, ref) {
      const i = ref ? this.children.indexOf(ref) : -1
      if (i < 0) this.children.unshift(child)
      else this.children.splice(i, 0, child)
      child.parentNode = this
      return child
    },
    querySelector(sel) {
      if (sel === 'span') return this.children.find((c) => c.tagName === 'span') || null
      if (sel === 'svg') return this.children.find((c) => c.tagName === 'svg') || null
      if (sel === '[data-dsh-remote-nav-icon]') {
        return this.children.find((c) => c.attrs && 'data-dsh-remote-nav-icon' in c.attrs) || null
      }
      return null
    },
  }
  return { button, svg, span }
}

test('settings nav title is short enough for the 188px rail', () => {
  const { dicts } = loadClient()
  assert.equal(dicts.zh['settings.title'], '远程工作区')
  assert.equal(dicts.en['settings.title'], 'Remote workspace')
  assert.ok(!String(dicts.zh['settings.title']).includes('dsh-remote'))
})

test('patchSettingsNavIcon hides the gear and inserts the server glyph on the matching row', () => {
  const { mod, doc } = loadClient()
  const patch = mod.__test && mod.__test.patchSettingsNavIcon
  assert.equal(typeof patch, 'function', 'client must expose patchSettingsNavIcon for the post-pass')

  const { button, svg } = fakeNavButton('远程工作区')
  doc.querySelectorAll = (sel) => (sel === '[data-shortcut-modal="settings"] button' ? [button] : [])

  const n = patch(doc, '远程工作区', doc)
  assert.equal(n, 1)
  assert.equal(svg.style.display, 'none')
  const icon = button.querySelector('[data-dsh-remote-nav-icon]')
  assert.ok(icon, 'server glyph must be inserted')
  assert.match(icon.innerHTML, /<svg/)
  assert.match(icon.innerHTML, /stroke="currentColor"/)
  assert.equal(button.children[0], icon, 'glyph must sit where the gear was')
})

test('patchSettingsNavIcon is idempotent and leaves other rows alone', () => {
  const { mod, doc } = loadClient()
  const patch = mod.__test.patchSettingsNavIcon
  const mine = fakeNavButton('远程工作区').button
  const other = fakeNavButton('通用').button
  doc.querySelectorAll = () => [other, mine]

  assert.equal(patch(doc, '远程工作区', doc), 1)
  assert.equal(patch(doc, '远程工作区', doc), 0)
  assert.equal(mine.querySelector('[data-dsh-remote-nav-icon]') ? 1 : 0, 1)
  assert.equal(other.querySelector('[data-dsh-remote-nav-icon]'), null)
  assert.equal(other.querySelector('svg').style.display, undefined)
})

test('installSettingsNavIcon degrades safely without MutationObserver', () => {
  const { mod } = loadClient()
  const install = mod.__test.installSettingsNavIcon
  assert.equal(typeof install, 'function')
  const dispose = install({ querySelectorAll: () => [], body: {} }, {}, () => '远程工作区')
  assert.equal(typeof dispose, 'function')
  assert.doesNotThrow(() => dispose())
})

test('installSettingsNavIcon observes the body and disconnects on dispose', () => {
  const { mod } = loadClient()
  const install = mod.__test.installSettingsNavIcon
  let observed = null
  let disconnected = false
  class FakeObserver {
    constructor(cb) { this.cb = cb }
    observe(target, opts) { observed = { target, opts } }
    disconnect() { disconnected = true }
  }
  const doc = { body: {}, querySelectorAll: () => [] }
  const win = { MutationObserver: FakeObserver, requestAnimationFrame: (fn) => fn() }
  const dispose = install(doc, win, () => '远程工作区')
  assert.ok(observed && observed.target === doc.body)
  assert.deepEqual(observed.opts, { childList: true, subtree: true })
  dispose()
  assert.equal(disconnected, true)
})
