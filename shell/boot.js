'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell boot — the orchestrator. Loads LAST, after every service and module
// has attached itself to window.shell.
//
// Responsibilities:
//   1. Config gate: bootstrap view if unconfigured, else the app.
//   2. Wire shared chrome (banner, outbox tray) and the module switcher.
//   3. Service worker registration + app-shell update banner.
//   4. The update "tick" (visibility/focus/interval) → SW check + delegate to
//      the active module's onTick() (photos uses it to refresh map config).
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  function boot() {
    shell.log(`UA: ${navigator.userAgent.slice(0, 70)}…`);
    shell.log(`navigator.share files: ${navigator.canShare ? 'check at share' : 'MISSING'}`);
    shell.log(`piexif: ${typeof piexif === 'object'}`);

    const cfg = shell.job.current();
    shell.log(`Config: job=${cfg.job} me=${cfg.me} rooms=${cfg.rooms.length} tags=${cfg.tags.length}${cfg._fromCache ? ' (from cache)' : ' (from URL)'}`);

    // Shared chrome works regardless of which view shows.
    shell.ui.banner.init();

    if (!shell.job.isConfigured()) {
      shell.job.showBootstrap();
      return;
    }

    // Header label
    const label = cfg.jobName ? `Job ${cfg.job} — ${cfg.jobName}` : `Job ${cfg.job}`;
    document.getElementById('jobLabel').textContent = `${label} · ${cfg.me}`;

    // Reveal the app, wire the outbox, bring up modules.
    document.getElementById('appView').hidden = false;
    shell.sync.init();
    shell.nav.init('photos');
  }

  // ── Update tick: SW refresh + active-module config check ─────────────────
  function tick() {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistration().then(reg => reg && reg.update());
    }
    const active = shell.nav.activeModule && shell.nav.activeModule();
    if (active && active.onTick) {
      try { active.onTick(); } catch (err) { shell.log(`tick(${active.id}): ${err.message}`); }
    }
  }

  function initUpdateChecks() {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') tick();
    });
    window.addEventListener('focus', tick);

    // Periodic poll while foregrounded — every 2 minutes (light ~2KB JSON).
    setInterval(() => {
      if (document.visibilityState === 'visible') tick();
    }, 2 * 60 * 1000);

    // One tick shortly after boot (catches very-recent config changes).
    setTimeout(tick, 30 * 1000);
  }

  // ── Service worker + app-shell update banner ─────────────────────────────
  function initServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').then(
        reg => {
          shell.log(`SW registered (scope: ${reg.scope})`);
          reg.addEventListener('updatefound', () => {
            const newWorker = reg.installing;
            if (!newWorker) return;
            newWorker.addEventListener('statechange', () => {
              if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                // New shell ready while an old one still controls.
                if (shell.sync.count() > 0) {
                  shell.ui.banner.show({
                    key: 'app',
                    message: 'App update — upload your items first',
                    onAction: () => location.reload()
                  });
                  return;
                }
                shell.log('App update installed — auto-reloading');
                setTimeout(() => location.reload(), 500);
              }
            });
          });
        },
        err => shell.log(`SW register failed: ${err.message}`)
      );
    });
  }

  // ── Go ───────────────────────────────────────────────────────────────────
  initServiceWorker();
  initUpdateChecks();
  boot();

})(window.shell);
