/**
 * Offline smoke test for the archive-last client bundle: pure order derivation,
 * the sort driver against stub Session/Workspace stores, the manual-order writes
 * it performs, and the restore on disposal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const bundlePath = fileURLToPath(new URL('../lib/client.js', import.meta.url))
const source = readFileSync(bundlePath, 'utf8')

const assert = (condition, message) => {
  if (!condition) throw new Error(`assertion failed: ${message}`)
}

let registration
globalThis.window = { __ModuleLoader__: { load: (entry) => { registration = entry } } }
new Function(source)()
assert(registration?.id === 'dsh-plugin-archive-last', 'bundle registers its package id')
const mod = registration.factory()
assert(typeof mod.apply === 'function', 'exports apply')
assert(Array.isArray(mod.inject), 'exports inject array')
for (const service of ['sessions', 'workspaces', 'uiWorkspace']) assert(mod.inject.includes(service), `injects ${service}`)
const internals = mod.internals
const { FLAT_SESSION_ORDER_KEY } = internals

// ---- pure ordering -------------------------------------------------------
const summaries = {
  a: { updatedAt: 100 },
  b: { updatedAt: 500 },
  c: { updatedAt: 300 },
  d: { updatedAt: 200 },
}
const archived = new Set(['b', 'd'])
assert(
  JSON.stringify(internals.orderAccount(['a', 'b', 'c', 'd'], summaries, archived)) === JSON.stringify(['c', 'a', 'b', 'd']),
  'active sessions sort by recency, archived follow newest-first',
)
assert(
  JSON.stringify(internals.orderAccount(['missing', 'a'], summaries, archived)) === JSON.stringify(['a']),
  'members without a summary are left for the official reconciler',
)

const sessionList = { phase: 'ready', ids: ['a', 'b', 'c', 'x'], byId: { ...summaries, x: { updatedAt: 50 } } }
const workspaceList = {
  phase: 'ready',
  items: [{ workspaceId: 'w1', sessionIds: ['a', 'b', 'c'] }],
  archivedSessionIds: ['b'],
  pinnedSessionIds: [],
}
const orders = internals.computeOrders(sessionList, workspaceList)
assert(JSON.stringify(orders.w1) === JSON.stringify(['c', 'a', 'b']), 'workspace order sinks the archive')
assert(JSON.stringify(orders['']) === JSON.stringify(['x']), 'ungrouped account holds stray sessions')
assert(JSON.stringify(orders[FLAT_SESSION_ORDER_KEY]) === JSON.stringify(['c', 'a', 'x', 'b']), 'flat account sinks the archive')

// ---- driver against stub stores -----------------------------------------
const store = (initial) => {
  let value = initial
  const listeners = new Set()
  return {
    getSnapshot: () => value,
    set(next) {
      value = next
      for (const listener of listeners) listener()
    },
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}
const sessions = { list: store(sessionList) }
const workspaces = { list: store(workspaceList) }
const calls = []
const appliedOrders = {}
const orderModes = []
const view = {
  setSessionOrder(accountKey, order, initialOrders) {
    calls.push({ accountKey, order, initialOrders })
    appliedOrders[accountKey] = order
  },
  setOrderBy(mode) {
    orderModes.push(mode)
  },
}
const uiWorkspace = { view }
const disposers = []
const ctx = {
  get: (name) => ({ sessions, workspaces, uiWorkspace })[name],
  effect: (callback) => {
    const disposer = callback()
    disposers.push(disposer)
    return disposer
  },
}
mod.apply(ctx, { applyDelayMs: 5, watchIntervalMs: 0 })
await new Promise((resolve) => setTimeout(resolve, 40))

assert(calls.length >= 1, 'driver writes the order')
assert(JSON.stringify(appliedOrders.w1) === JSON.stringify(['c', 'a', 'b']), 'driver sinks the archived row per workspace')
assert(JSON.stringify(appliedOrders[FLAT_SESSION_ORDER_KEY]) === JSON.stringify(['c', 'a', 'x', 'b']), 'driver writes the flat account')
assert(
  calls[0].initialOrders !== undefined && calls[0].initialOrders.w1 !== undefined && calls[0].initialOrders[FLAT_SESSION_ORDER_KEY] !== undefined,
  'first write carries the complete initial order map so the mode switch keeps every account',
)

// archive another session; the driver re-derives without a reload.
workspaces.list.set({ ...workspaceList, archivedSessionIds: ['b', 'a'] })
await new Promise((resolve) => setTimeout(resolve, 40))
assert(JSON.stringify(appliedOrders.w1) === JSON.stringify(['c', 'b', 'a']), 'archiving re-sinks the row on the next list settle')

// disabling restores the official recent order and stops writing.
for (const dispose of disposers) dispose()
assert(orderModes.at(-1) === 'updated', 'disposal restores the recent order')
const writes = calls.length
workspaces.list.set({ ...workspaceList, archivedSessionIds: [] })
await new Promise((resolve) => setTimeout(resolve, 40))
assert(calls.length === writes, 'no writes after disposal')

// ---- capability guard ---------------------------------------------------
const quiet = { get: () => undefined, effect: () => {} }
mod.apply(quiet)

console.log('archive-last client smoke test: PASS')
