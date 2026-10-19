window.__ModuleLoader__.load({
	id: "dsh-plugin-archive-last",
	factory: () => {
		var exports = {}

		/** Browser-local order account for the hierarchy-free flat Session list (official constant). */
		const FLAT_SESSION_ORDER_KEY = "__flat_session_order__"
		/** Debounce before rewriting the manual order (ms), so one quiet moment produces one write. */
		const DEFAULT_APPLY_DELAY_MS = 700
		/** How often the store is re-read to notice a switch back to the official recent order (ms). */
		const DEFAULT_WATCH_INTERVAL_MS = 10000
		/** Persisted view-store key of the official workspace browser. */
		const VIEW_PERSIST_KEY = "dsh.workspace.view.v5"

		/**
		 * Order one account: unarchived conversations keep the recent-activity order,
		 * archived conversations follow them, newest archived first. Unknown members
		 * are left out and re-added by the official reconciler.
		 * @param memberIds - account membership in host order.
		 * @param summaries - Session metadata by id.
		 * @param archived - registry-global archived Session ids.
		 * @returns the desired order for one account.
		 */
		function orderAccount(memberIds, summaries, archived) {
			const active = []
			const hidden = []
			const seen = new Set()
			for (const id of memberIds) {
				const summary = summaries[id]
				if (summary === undefined || seen.has(id)) continue
				seen.add(id)
				if (archived.has(id)) hidden.push(id)
				else active.push(id)
			}
			const recency = (left, right) => {
				const a = summaries[left]?.updatedAt ?? 0
				const b = summaries[right]?.updatedAt ?? 0
				if (a !== b) return b - a
				return left < right ? -1 : 1
			}
			active.sort(recency)
			hidden.sort(recency)
			return [...active, ...hidden]
		}

		/**
		 * Compute the desired manual order for every order account: each Workspace,
		 * Ungrouped, and the flat list.
		 * @param sessionList - Session list snapshot (`ids`, `byId`).
		 * @param workspaceList - Workspace registry snapshot (`items`, `archivedSessionIds`).
		 * @returns order per account key.
		 */
		function computeOrders(sessionList, workspaceList) {
			const archived = new Set(workspaceList.archivedSessionIds ?? [])
			const summaries = sessionList.byId ?? {}
			const orders = {}
			const accounted = new Set()
			for (const item of workspaceList.items ?? []) {
				const memberIds = item.sessionIds ?? []
				for (const id of memberIds) accounted.add(id)
				orders[item.workspaceId] = orderAccount(memberIds, summaries, archived)
			}
			const ungrouped = (sessionList.ids ?? []).filter((id) => summaries[id] !== undefined && !accounted.has(id))
			orders[""] = orderAccount(ungrouped, summaries, archived)
			const flat = (sessionList.ids ?? []).filter((id) => summaries[id] !== undefined)
			orders[FLAT_SESSION_ORDER_KEY] = orderAccount(flat, summaries, archived)
			return orders
		}

		/** Compare two order maps without allocating JSON for untouched accounts. */
		function sameOrders(left, right) {
			const leftKeys = Object.keys(left)
			if (leftKeys.length !== Object.keys(right).length) return false
			for (const key of leftKeys) {
				const a = left[key]
				const b = right[key]
				if (b === undefined || a.length !== b.length) return false
				for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
			}
			return true
		}

		/** The official view mode persisted in the browser, when the payload is readable. */
		function persistedOrderMode() {
			try {
				const storage = globalThis.localStorage
				const raw = storage?.getItem?.(VIEW_PERSIST_KEY)
				if (typeof raw !== "string") return undefined
				const value = JSON.parse(raw)
				return typeof value?.orderBy === "string" ? value.orderBy : undefined
			} catch (_error) {
				return undefined
			}
		}

		/**
		 * archive-last: keep the browser's own recent-activity order for live
		 * conversations and sink archived conversations to the end of every account
		 * (each Workspace, Ungrouped, and the flat list). The official list has no
		 * sorting hook, so this drives its own manual order every time the Session or
		 * Workspace registries change, then restores the recent order when disabled.
		 * @param ctx - client root context with the injected services.
		 * @param config - optional row config: `applyDelayMs`, `watchIntervalMs`.
		 */
		function apply(ctx, config) {
			const sessions = ctx.get("sessions")
			const workspaces = ctx.get("workspaces")
			const uiWorkspace = ctx.get("uiWorkspace")
			const view = uiWorkspace?.view
			const canWrite = typeof view?.setSessionOrder === "function"
			if (sessions?.list === undefined || workspaces?.list === undefined || !canWrite) {
				console.warn("[archive-last] the official workspace browser services are unavailable; sorting disabled")
				return
			}
			const applyDelayMs = typeof config?.applyDelayMs === "number" ? config.applyDelayMs : DEFAULT_APPLY_DELAY_MS
			const watchIntervalMs = typeof config?.watchIntervalMs === "number" ? config.watchIntervalMs : DEFAULT_WATCH_INTERVAL_MS
			let timer
			let watchTimer
			let disposed = false
			let applied
			
			const applyNow = () => {
				timer = undefined
				if (disposed) return
				const sessionList = sessions.list.getSnapshot()
				const workspaceList = workspaces.list.getSnapshot()
				if (sessionList?.phase !== "ready" || workspaceList?.phase !== "ready") return
				const orders = computeOrders(sessionList, workspaceList)
				if (applied !== undefined && sameOrders(applied, orders)) return
				applied = orders
				try {
					for (const accountKey of Object.keys(orders)) view.setSessionOrder(accountKey, orders[accountKey], orders)
				} catch (error) {
					applied = undefined
					console.warn("[archive-last] could not write the manual order", error)
				}
			}
			const schedule = () => {
				if (disposed || timer !== undefined) return
				timer = setTimeout(applyNow, applyDelayMs)
			}
			const reassert = () => {
				if (disposed) return
				if (persistedOrderMode() === "updated") {
					applied = undefined
					schedule()
				}
			}
			const disposers = [sessions.list.subscribe(schedule), workspaces.list.subscribe(schedule)]
			if (watchIntervalMs > 0) watchTimer = setInterval(reassert, watchIntervalMs)
			ctx.effect(() => () => {
				disposed = true
				if (timer !== undefined) clearTimeout(timer)
				if (watchTimer !== undefined) clearInterval(watchTimer)
				for (const dispose of disposers) dispose()
				try {
					if (typeof view.setOrderBy === "function") view.setOrderBy("updated")
				} catch (error) {
					console.warn("[archive-last] could not restore the recent order", error)
				}
			}, "archive-last: sorting driver")
			schedule()
		}

		/** Test seam: expose the pure ordering helpers for the offline smoke test. */
		exports.internals = { FLAT_SESSION_ORDER_KEY, computeOrders, sameOrders, orderAccount, persistedOrderMode }
		exports.apply = apply
		exports.inject = ["sessions", "workspaces", "uiWorkspace"]
		return exports
	},
})
