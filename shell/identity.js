'use strict';

// ─────────────────────────────────────────────────────────────────────────
// Shell identity — MSAL login + Microsoft Graph token acquisition.
//
// The field hub's identity layer (FIELD-HUB-PLAN §4). Today it backs the
// OneDrive upload; long-term it's "who is this foreman" for every module.
// Generic token getter: the *scopes* are the caller's business (sync asks
// for Files.ReadWrite.AppFolder), identity just gets a token for them.
// ─────────────────────────────────────────────────────────────────────────

(function (shell) {

  const MSAL_CLIENT_ID = '239f56eb-22b0-4af6-86d4-272126d390a9';

  let _pca = null;        // MSAL PublicClientApplication, lazily created
  let _pcaReady = null;   // resolves once redirect handling is done

  function getMsalApp() {
    if (_pca) return _pcaReady.then(() => _pca);
    if (typeof msal === 'undefined') {
      return Promise.reject(new Error('MSAL library not loaded'));
    }
    // App base URL = origin + directory (matches registered redirect URIs:
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
    _pcaReady = _pca.handleRedirectPromise().catch(err => shell.log(`MSAL redirect: ${err.message}`));
    return _pcaReady.then(() => _pca);
  }

  // Acquire a Graph access token for the given scopes. Signs in (popup) on
  // first use, then prefers silent acquisition, falling back to popup if
  // interaction is required (consent/expired).
  async function getToken(scopes) {
    const pca = await getMsalApp();
    let account = pca.getActiveAccount() || pca.getAllAccounts()[0];
    if (!account) {
      shell.log('Signing in to Microsoft…');
      const res = await pca.loginPopup({ scopes });
      account = res.account;
      pca.setActiveAccount(account);
      shell.log(`✓ Signed in as ${account.username}`);
    }
    try {
      const r = await pca.acquireTokenSilent({ scopes, account });
      return r.accessToken;
    } catch (err) {
      const r = await pca.acquireTokenPopup({ scopes });
      return r.accessToken;
    }
  }

  // Current signed-in username, or null. Synchronous — only reflects state if
  // MSAL has already been initialized (i.e. after a sign-in this session).
  function username() {
    if (!_pca) return null;
    const acct = _pca.getActiveAccount() || _pca.getAllAccounts()[0];
    return acct ? acct.username : null;
  }

  shell.identity = { getToken, username, clientId: MSAL_CLIENT_ID };

})(window.shell);
