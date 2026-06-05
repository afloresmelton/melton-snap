'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell job context — "which job am I on" + who I am (FIELD-HUB-PLAN §4).
//
// The field analog of the office hub's "active workspace." Config arrives in
// the foreman's bootstrap link (?job=&me=&map=&rooms=&tags=), is cached in
// localStorage so the home-screen icon "just works," and is exposed to every
// module via shell.job.current(). This file also owns the two non-app views:
// first-time bootstrap (paste your link) and the error/setup-needed screen.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const DEFAULTS = {
    tags: ['Rough-In', 'Finish', 'Inspection', 'Deficiency', 'Before', 'After', 'Material'],
    rooms: []
  };
  const CONFIG_STORAGE_KEY = 'melton-snap-config';

  function parseConfig() {
    const params = new URLSearchParams(location.search);

    // Reset escape hatch — `?reset=1` clears saved config and forces re-bootstrap
    if (params.get('reset') === '1') {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
    }

    const fromURL = {
      job: params.get('job') || '',
      jobName: params.get('name') || '',
      me: params.get('me') || '',
      mapUrl: params.get('map') || '',
      rooms: (params.get('rooms') || '').split(',').map(s => s.trim()).filter(Boolean),
      tags: params.get('tags')
        ? params.get('tags').split(',').map(s => s.trim()).filter(Boolean)
        : DEFAULTS.tags
    };

    // URL is the source of truth when it has valid config — save for next launch
    if (fromURL.job && fromURL.me) {
      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(fromURL));
      } catch (err) {
        // localStorage might fail in private mode; not fatal
      }
      return fromURL;
    }

    // URL is bare (e.g., launched from home-screen icon via manifest start_url).
    // Fall back to last saved config so the icon "just works."
    try {
      const saved = JSON.parse(localStorage.getItem(CONFIG_STORAGE_KEY) || 'null');
      if (saved && saved.job && saved.me) {
        saved._fromCache = true;
        return saved;
      }
    } catch (err) {
      // Corrupt localStorage; ignore
    }

    return fromURL; // empty -> error/bootstrap view
  }

  const CFG = parseConfig();

  // ── Bootstrap view (first-time link paste) ──────────────────────────────
  function showBootstrap() {
    document.getElementById('appView').hidden = true;
    document.getElementById('errorView').hidden = true;
    document.getElementById('bootstrapView').hidden = false;

    const submitBtn = document.getElementById('bootstrapSubmit');
    const pasteBtn = document.getElementById('bootstrapPasteBtn');
    const input = document.getElementById('bootstrapInput');
    const errorEl = document.getElementById('bootstrapError');

    if (submitBtn.dataset.bound) return; // avoid double-binding
    submitBtn.dataset.bound = '1';

    pasteBtn.addEventListener('click', async () => {
      errorEl.hidden = true;
      if (!navigator.clipboard || !navigator.clipboard.readText) {
        bootstrapError('Clipboard access not available — paste manually into the box above.');
        return;
      }
      try {
        const text = await navigator.clipboard.readText();
        if (text) {
          input.value = text;
          shell.log(`Pasted from clipboard (${text.length} chars)`);
        } else {
          bootstrapError('Clipboard was empty.');
        }
      } catch (err) {
        bootstrapError(`Clipboard read denied: ${err.message}. Paste manually instead.`);
      }
    });

    submitBtn.addEventListener('click', () => {
      errorEl.hidden = true;
      const text = input.value.trim();
      if (!text) {
        bootstrapError('Paste the link first.');
        return;
      }

      let params;
      try {
        params = new URL(text).searchParams;
      } catch {
        const idx = text.indexOf('?');
        try {
          params = new URLSearchParams(idx >= 0 ? text.slice(idx + 1) : text);
        } catch {
          bootstrapError('Could not parse that link. Make sure you pasted the full URL.');
          return;
        }
      }

      const job = params.get('job') || '';
      const me = params.get('me') || '';
      if (!job || !me) {
        const missing = [!job && '"job"', !me && '"me"'].filter(Boolean).join(' and ');
        bootstrapError(`Link is missing required value(s): ${missing}.`);
        return;
      }

      const config = {
        job,
        jobName: params.get('name') || '',
        me,
        mapUrl: params.get('map') || '',
        rooms: (params.get('rooms') || '').split(',').map(s => s.trim()).filter(Boolean),
        tags: params.get('tags')
          ? params.get('tags').split(',').map(s => s.trim()).filter(Boolean)
          : DEFAULTS.tags
      };

      try {
        localStorage.setItem(CONFIG_STORAGE_KEY, JSON.stringify(config));
      } catch (err) {
        bootstrapError(`Could not save config: ${err.message}`);
        return;
      }

      shell.log(`✓ Bootstrap saved config: job=${config.job} me=${config.me}`);
      location.replace('./'); // reload so boot() picks up saved config cleanly
    });

    function bootstrapError(msg) {
      errorEl.textContent = msg;
      errorEl.hidden = false;
    }
  }

  function showError(html) {
    document.getElementById('appView').hidden = true;
    document.getElementById('bootstrapView').hidden = true;
    const errView = document.getElementById('errorView');
    errView.hidden = false;
    document.getElementById('errorMsg').innerHTML = html;
  }

  // Clear config and reload into bootstrap. No native confirm() — flaky in iOS
  // standalone PWAs. The bootstrap view IS the undo path: paste the link again.
  function switchJob() {
    shell.log('Switch job tapped — clearing config + reloading');
    try {
      localStorage.removeItem(CONFIG_STORAGE_KEY);
    } catch (err) {
      shell.log(`localStorage clear failed: ${err.message}`);
    }
    location.replace('./');
  }

  shell.job = {
    current() { return CFG; },
    me() { return CFG.me; },
    jobNo() { return CFG.job; },
    jobName() { return CFG.jobName; },
    tags() { return CFG.tags; },
    rooms() { return CFG.rooms; },
    mapUrl() { return CFG.mapUrl; },
    isConfigured() { return !!(CFG.job && CFG.me); },
    fromCache() { return !!CFG._fromCache; },
    showBootstrap,
    showError,
    switchJob,
    _storageKey: CONFIG_STORAGE_KEY
  };

})(window.shell);
