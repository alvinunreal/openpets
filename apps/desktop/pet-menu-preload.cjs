// Preload for the layer-shell pet context-menu window.
//
// The pet's offscreen window cannot host an Electron `Menu.popup` (the menu
// would not be shown on Wayland), so the layer-shell backend shows the pet's
// context menu in a small standalone window instead. This preload renders the
// menu items sent by the main process and reports clicks back over IPC.

const { ipcRenderer } = require("electron");

ipcRenderer.on("openpets:pet-menu-data", (_event, menu) => {
  renderMenu(menu);
});

function renderMenu(menu) {
  const root = document.getElementById("menu");
  if (!root) return;
  root.innerHTML = "";
  const walk = (items, container) => {
    for (const item of items) {
      if (item.type === "separator") {
        const sep = document.createElement("div");
        sep.className = "sep";
        container.appendChild(sep);
        continue;
      }
      const row = document.createElement("div");
      row.className = "item";
      row.textContent = item.label || "";
      if (item.submenu && item.submenu.length > 0) {
        row.classList.add("has-sub");
        const sub = document.createElement("div");
        sub.className = "submenu";
        walk(item.submenu, sub);
        row.appendChild(sub);
      }
      if (typeof item.clickIndex === "number") {
        row.classList.add("clickable");
        row.addEventListener("click", (event) => {
          event.stopPropagation();
          ipcRenderer.send("openpets:pet-menu-select", item.clickIndex);
        });
      }
      container.appendChild(row);
    }
  };
  walk(menu.items || [], root);
}
