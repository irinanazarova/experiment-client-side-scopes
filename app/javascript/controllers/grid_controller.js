import { Controller } from "@hotwired/stimulus"

// The whole client for the server-push spreadsheet. Three jobs, all driven by
// the Turbo refresh that the server broadcasts after a write:
//   - inline cell editing (click a cell, POST a single-cell write)
//   - a "server activity" toggle that posts a write once a second
//   - flash + latency: compare the grid before/after each morph, blink changed
//     cells (yellow if you made the change, green if it came from elsewhere),
//     and time your action all the way to the morph.
const FLASH_MS = 1500
const RECENT_MS = 3000
const TICK_MS = 1000

export default class extends Controller {
  static values = { cellUrl: String, tickUrl: String }
  static targets = ["server", "latency", "flow"]

  connect() {
    this.recent = new Map() // "row:col" -> expiry; cells you just touched
    this.snapshot = null
    this.actionAt = null
    this.actionKind = null
    this.serverTimer = null
    this._click = this.onClick.bind(this)
    this._before = () => { this.snapshot = this.cellMap() }
    this._render = this.onRender.bind(this)
    this.element.addEventListener("click", this._click)
    document.addEventListener("turbo:before-render", this._before)
    document.addEventListener("turbo:render", this._render)
  }

  disconnect() {
    this.stopServer()
    this.element.removeEventListener("click", this._click)
    document.removeEventListener("turbo:before-render", this._before)
    document.removeEventListener("turbo:render", this._render)
  }

  get csrf() { return document.querySelector('meta[name="csrf-token"]')?.content || "" }

  cellMap() {
    const map = new Map()
    this.element.querySelectorAll(".ss-cell").forEach((c) =>
      map.set(`${c.dataset.row}:${c.dataset.col}`, c.textContent.trim()))
    return map
  }

  markRecent(row, col) { this.recent.set(`${row}:${col}`, Date.now() + RECENT_MS) }

  post(url, body) {
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-CSRF-Token": this.csrf },
      body: new URLSearchParams(body)
    })
  }

  begin(kind) { this.actionAt = performance.now(); this.actionKind = kind }

  // --- inline cell editing ---
  onClick(event) {
    const cell = event.target.closest(".ss-cell")
    if (!cell || cell.querySelector("input")) return
    const original = cell.textContent.trim()
    const input = document.createElement("input")
    input.type = "number"
    input.value = original.replace(/,/g, "")
    input.style.cssText = "width:100%;text-align:right"
    cell.textContent = ""
    cell.appendChild(input)
    input.focus()
    input.select()

    let done = false
    const commit = () => {
      if (done) return
      done = true
      const value = input.value
      cell.textContent = original // the morph brings back the authoritative value
      this.begin("local")
      this.markRecent(cell.dataset.row, cell.dataset.col)
      this.post(this.cellUrlValue, { row: cell.dataset.row, col: cell.dataset.col, value })
    }
    input.addEventListener("blur", commit)
    input.addEventListener("keydown", (key) => {
      if (key.key === "Enter") commit()
      else if (key.key === "Escape") { done = true; cell.textContent = original }
    })
  }

  // --- apply to whole column (the form submits via Turbo) ---
  apply(event) {
    this.begin("local")
    const col = event.target.querySelector('[name="column"]')?.value
    if (col) this.element.querySelectorAll(`.ss-cell[data-col="${col}"]`)
      .forEach((c) => this.markRecent(c.dataset.row, col))
  }

  // --- server activity: a server-originated write once a second ---
  toggleServer() { this.serverTimer ? this.stopServer() : this.startServer() }

  startServer() {
    this.setServerLabel(true)
    const tick = () => { this.begin("server"); this.post(this.tickUrlValue, {}) }
    tick()
    this.serverTimer = setInterval(tick, TICK_MS)
  }

  stopServer() {
    if (this.serverTimer) clearInterval(this.serverTimer)
    this.serverTimer = null
    this.setServerLabel(false)
  }

  setServerLabel(on) {
    if (!this.hasServerTarget) return
    this.serverTarget.textContent = on ? "Server activity: on" : "Server activity: off"
    this.serverTarget.classList.toggle("active", on)
  }

  // --- flash + latency, on every morph ---
  onRender() {
    if (!this.snapshot) return
    const before = this.snapshot
    this.snapshot = null
    const now = Date.now()
    let changed = 0
    this.element.querySelectorAll(".ss-cell").forEach((c) => {
      const key = `${c.dataset.row}:${c.dataset.col}`
      const was = before.get(key)
      if (was !== undefined && was !== c.textContent.trim()) {
        changed++
        const mine = (this.recent.get(key) || 0) > now
        this.flash(c, mine ? "flash-local" : "flash-remote")
      }
    })
    if (changed > 0 || this.actionAt != null) this.trace(changed)
  }

  flash(cell, klass) {
    cell.classList.remove("flash-local", "flash-remote")
    void cell.offsetWidth // restart the animation
    cell.classList.add(klass)
    setTimeout(() => cell.classList.remove(klass), FLASH_MS)
  }

  trace(changed) {
    const kind = this.actionKind
    const ms = this.actionAt != null ? Math.round(performance.now() - this.actionAt) : null
    this.actionAt = null
    this.actionKind = null

    if (this.hasFlowTarget) {
      this.flowTarget.classList.remove("local", "remote")
      void this.flowTarget.offsetWidth
      this.flowTarget.classList.add(kind === "local" ? "local" : "remote")
    }
    if (this.hasLatencyTarget) {
      const cells = `${changed} cell${changed === 1 ? "" : "s"}`
      this.latencyTarget.textContent =
        kind === "local" ? `your edit → morph: ${ms} ms · ${cells}`
        : kind === "server" ? `server write → morph: ${ms} ms · ${cells}`
        : `remote change → morph · ${cells}`
    }
  }
}
