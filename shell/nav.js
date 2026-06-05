'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell nav — module registry + bottom-tab switcher (FIELD-HUB-PLAN §4).
//
// Modules self-register on load. Each provides a manifest:
//   { id, name, icon, rootId, mount(rootEl), onShow?, onHide?, onTick? }
// Activating a module hides the others' root elements, lazily calls mount()
// once, and re-renders the tab bar. The switcher only appears when there's
// more than one module — a single-module hub looks exactly like v1 Snap.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const modules = [];   // [{ ...manifest, _mounted }]
  let activeId = null;

  function register(manifest) {
    if (!manifest || !manifest.id) throw new Error('Module manifest needs an id');
    if (modules.find(m => m.id === manifest.id)) {
      shell.log(`Module ${manifest.id} already registered — skipping`);
      return;
    }
    modules.push(Object.assign({ _mounted: false }, manifest));
    shell.log(`Module registered: ${manifest.id} (${manifest.name})`);
  }

  function get(id) { return modules.find(m => m.id === id) || null; }

  function activeModule() { return get(activeId); }

  function activate(id) {
    const target = get(id);
    if (!target) { shell.log(`activate: no module "${id}"`); return; }

    const prev = activeModule();
    if (prev && prev.id !== id && prev.onHide) {
      try { prev.onHide(); } catch (err) { shell.log(`✗ ${prev.id}.onHide: ${err.message}`); }
    }

    activeId = id;

    // Toggle module-view roots
    for (const m of modules) {
      const root = document.getElementById(m.rootId);
      if (root) root.hidden = (m.id !== id);
    }

    // Mount once, on first activation
    if (!target._mounted) {
      target._mounted = true;
      try {
        if (target.mount) target.mount(document.getElementById(target.rootId));
      } catch (err) {
        shell.log(`✗ Module ${target.id} mount failed: ${err.message}`);
        console.error(err);
      }
    }

    if (target.onShow) {
      try { target.onShow(); } catch (err) { shell.log(`✗ ${target.id}.onShow: ${err.message}`); }
    }

    renderNav();
  }

  function renderNav() {
    const nav = document.getElementById('moduleNav');
    if (!nav) return;
    // Single-module hub: no switcher chrome (keeps v1 Snap look).
    nav.hidden = modules.length < 2;
    nav.innerHTML = modules.map(m =>
      `<button type="button" class="nav-tab${m.id === activeId ? ' active' : ''}" data-mod="${shell.util.escapeAttr(m.id)}">
        <span class="nav-icon">${m.icon || '▢'}</span>
        <span class="nav-label">${shell.util.escapeHtml(m.name)}</span>
      </button>`
    ).join('');
  }

  function init(defaultId) {
    const nav = document.getElementById('moduleNav');
    if (nav) {
      nav.addEventListener('click', (e) => {
        const btn = e.target.closest('.nav-tab');
        if (!btn) return;
        if (btn.dataset.mod !== activeId) activate(btn.dataset.mod);
      });
    }
    renderNav();
    activate(defaultId || (modules[0] && modules[0].id));
  }

  shell.nav = {
    register,
    activate,
    init,
    current: () => activeId,
    activeModule,
    modules: () => modules.slice()
  };

})(window.shell);
