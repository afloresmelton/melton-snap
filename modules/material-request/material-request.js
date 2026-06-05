'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Module #2 — Field Materials Request  (STUB, Phase 2.0)
//
// Registers in the nav so the module registry/switcher is real, not
// hypothetical. The working form arrives in Phase 2.1, where it will compose
// the same shell.capture (attach a nameplate photo) and shell.sync.enqueue
// (drop a matreq__*.json into the job folder) the photos module uses today.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  function mount(root) {
    root.innerHTML = `
      <section class="field">
        <h2 style="margin:4px 0;">Field Materials Request</h2>
        <p class="hint" style="text-align:left;">
          "I need X on this job." Add items, attach a photo of the nameplate,
          set urgency, and submit — it queues offline and uploads to the job
          folder for the office to turn into a vendor order.
        </p>
        <p class="hint" style="text-align:left;color:var(--warn);">
          🚧 Coming in Phase 2.1. This tab proves the module switcher works —
          the shell now hosts more than photos.
        </p>
      </section>`;
    shell.log('Materials Request stub mounted');
  }

  shell.nav.register({
    id: 'material-request',
    name: 'Materials',
    icon: '🧰',
    rootId: 'module-material-request',
    mount
  });

})(window.shell);
