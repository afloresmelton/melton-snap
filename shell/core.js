'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell core — the field-hub global namespace.
//
// Every shell service (identity/job/sync/capture/nav) and every module hangs
// off `window.shell`. This file creates the base object plus the things that
// are genuinely shared by everyone: the debug logger, the one update banner,
// and a handful of tiny helpers. Load this FIRST.
// ─────────────────────────────────────────────────────────────────────────

window.shell = window.shell || {};

(function (shell) {

  // ── Logging → debug pane (and console for desktop) ──────────────────────
  shell.log = function (msg) {
    const el = document.getElementById('log');
    if (el) {
      const t = new Date().toTimeString().slice(0, 8);
      el.textContent = `[${t}] ${msg}\n` + el.textContent;
    }
    if (window.console && console.log) console.log('[snap]', msg);
  };

  // ── Shared update banner ────────────────────────────────────────────────
  // One sticky banner (#updateBanner) drives both "app shell updated" and
  // "map config updated." Callers supply a dismiss `key` (session-scoped
  // suppression), a message, and the action to run on "Refresh now."
  const banner = {
    _active: null,            // { key, onAction }
    _dismissed: new Set(),    // keys the user dismissed this session

    show({ key, message, actionLabel = 'Refresh now', onAction }) {
      if (key && this._dismissed.has(key)) return;
      this._active = { key: key || null, onAction: onAction || null };
      const el = document.getElementById('updateBanner');
      if (!el) return;
      el.querySelector('.update-text').textContent = message;
      const btn = el.querySelector('#updateRefreshBtn');
      if (btn) btn.textContent = actionLabel;
      el.hidden = false;
      shell.log(`Banner: ${message}`);
    },

    hide() {
      this._active = null;
      const el = document.getElementById('updateBanner');
      if (el) el.hidden = true;
    },

    isShowing(key) {
      return !!(this._active && (!key || this._active.key === key));
    },

    _refresh() {
      const a = this._active;
      this.hide();
      if (a && a.onAction) a.onAction();
    },

    _dismiss() {
      const a = this._active;
      if (a && a.key) this._dismissed.add(a.key);
      this.hide();
    },

    init() {
      const r = document.getElementById('updateRefreshBtn');
      const d = document.getElementById('updateDismissBtn');
      if (r) r.addEventListener('click', () => this._refresh());
      if (d) d.addEventListener('click', () => this._dismiss());
    }
  };
  shell.ui = { banner };

  // ── Tiny shared helpers ─────────────────────────────────────────────────
  const util = {
    slug(s) {
      return (s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    },
    escapeHtml(s) {
      return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    },
    escapeAttr(s) { return util.escapeHtml(s); },
    fileToDataUrl(file) {
      return new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.readAsDataURL(file);
      });
    },
    dataUrlToFile(dataUrl, filename) {
      const [meta, b64] = dataUrl.split(',');
      const mime = meta.match(/:(.*?);/)[1];
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new File([bytes], filename, { type: mime });
    }
  };
  shell.util = util;

})(window.shell);
