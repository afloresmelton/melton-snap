'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell identity — MSAL login + Microsoft Graph tokens via the REDIRECT flow.
//
// Why redirect, not popup: iOS standalone PWAs (Add to Home Screen) block
// window.open popups, so loginPopup/acquireTokenPopup silently fail with
// "popup blocked." The redirect flow navigates the whole page to Microsoft
// and back; init()'s handleRedirectPromise() finishes the round-trip on
// return. Because the page reloads mid-sign-in, the outbox must be durable —
// see shell.sync (IndexedDB) + the auto-resume in boot.js.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const MSAL_CLIENT_ID = '239f56eb-22b0-4af6-86d4-272126d390a9';

  let _pca = null;            // MSAL PublicClientApplication
  let _initPromise = null;    // init() runs once
  let _redirectResult = null; // non-null iff this page load returned from sign-in

  // Create the MSAL app and process any pending redirect response. Idempotent.
  function init() {
    if (_initPromise) return _initPromise;
    _initPromise = (async () => {
      if (typeof msal === 'undefined') { shell.log('MSAL library not loaded'); return; }
      // App base URL = origin + directory (matches the registered redirect URI:
      // https://afloresmelton.github.io/melton-snap/  and  http://localhost:5173/)
      const appBase = location.origin + location.pathname.replace(/[^/]*$/, '');
      _pca = new msal.PublicClientApplication({
        auth: {
          clientId: MSAL_CLIENT_ID,
          authority: 'https://login.microsoftonline.com/common',
          redirectUri: appBase
        },
        cache: { cacheLocation: 'localStorage' }
      });
      try {
        _redirectResult = await _pca.handleRedirectPromise();
        if (_redirectResult && _redirectResult.account) {
          _pca.setActiveAccount(_redirectResult.account);
          shell.log(`✓ Signed in as ${_redirectResult.account.username}`);
        } else if (!_pca.getActiveAccount() && _pca.getAllAccounts()[0]) {
          _pca.setActiveAccount(_pca.getAllAccounts()[0]);
        }
      } catch (err) {
        shell.log(`MSAL redirect error: ${err.message}`);
      }
    })();
    return _initPromise;
  }

  // True if this page load just returned from an interactive sign-in — boot
  // uses it to auto-resume a pending upload.
  function justAuthenticated() { return !!_redirectResult; }

  function isSignedIn() {
    return !!(_pca && (_pca.getActiveAccount() || _pca.getAllAccounts()[0]));
  }

  // Acquire a Graph token for `scopes`. Tries silent first; if interaction is
  // needed and opts.interactive !== false, kicks off a full-page redirect to
  // sign in (the returned promise never resolves — the page is unloading, and
  // the upload resumes after the round-trip). With opts.interactive === false
  // it throws instead of redirecting (used by auto-resume to avoid loops).
  async function getToken(scopes, opts = {}) {
    await init();
    if (!_pca) throw new Error('MSAL not available');

    const account = _pca.getActiveAccount() || _pca.getAllAccounts()[0];
    if (account) {
      try {
        const r = await _pca.acquireTokenSilent({ scopes, account });
        return r.accessToken;
      } catch (err) {
        shell.log(`Silent token failed (${err.errorCode || err.message})`);
      }
    }

    if (opts.interactive === false) {
      throw new Error('Sign-in required');
    }

    shell.log('Redirecting to Microsoft sign-in…');
    await _pca.acquireTokenRedirect({ scopes }); // navigates away
    return new Promise(() => {});                 // unreachable; page is unloading
  }

  function username() {
    if (!_pca) return null;
    const acct = _pca.getActiveAccount() || _pca.getAllAccounts()[0];
    return acct ? acct.username : null;
  }

  shell.identity = { init, getToken, username, isSignedIn, justAuthenticated, clientId: MSAL_CLIENT_ID };

})(window.shell);
