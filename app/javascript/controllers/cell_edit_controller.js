import { Controller } from "@hotwired/stimulus"

// Click a cell to edit it. On commit we POST a single-cell write to the server
// and let the Turbo refresh broadcast morph the new value back in. Plain
// Hotwire: no local database, the server is the authority. Attached to the
// table; cell clicks are handled by delegation so the row partial stays shared
// with the other routes.
export default class extends Controller {
  static values = { url: String }

  connect() {
    this.onClick = this.onClick.bind(this)
    this.element.addEventListener("click", this.onClick)
  }

  disconnect() {
    this.element.removeEventListener("click", this.onClick)
  }

  onClick(event) {
    const cell = event.target.closest(".ss-cell")
    if (!cell || cell.querySelector("input")) return

    const original = cell.textContent.trim()
    const input = document.createElement("input")
    input.type = "number"
    input.value = original.replace(/,/g, "")
    input.style.width = "100%"
    input.style.textAlign = "right"
    cell.textContent = ""
    cell.appendChild(input)
    input.focus()
    input.select()

    const cancel = () => { cell.textContent = original }
    const commit = () => {
      const value = input.value
      cell.textContent = value // optimistic; the broadcast morph confirms it
      this.write(cell.dataset.row, cell.dataset.col, value)
    }

    input.addEventListener("blur", commit, { once: true })
    input.addEventListener("keydown", (key) => {
      if (key.key === "Enter") input.blur()
      else if (key.key === "Escape") { input.removeEventListener("blur", commit); cancel() }
    })
  }

  write(row, col, value) {
    fetch(this.urlValue, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-CSRF-Token": document.querySelector('meta[name="csrf-token"]')?.content || ""
      },
      body: new URLSearchParams({ row, col, value })
    })
  }
}
