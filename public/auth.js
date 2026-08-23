function getRole() {
  return localStorage.getItem('op_role') || '';
}

function injectTopBar() {
  if (document.getElementById('topActionBar')) return;
  const bar = document.createElement('div');
  bar.id = 'topActionBar';
  bar.innerHTML = `
    <a href="index.html" class="top-action">🏠 Home</a>
    <button id="logoutBtn" class="top-action" type="button">🚪 Log Out</button>
  `;
  document.body.insertBefore(bar, document.body.firstChild);
  document.getElementById('logoutBtn').addEventListener('click', () => {
    localStorage.removeItem('op_role');
    location.reload();
  });
}

function injectSearchBar() {
  if (document.getElementById('globalSearch')) return;
  const navTabsGroups = document.querySelectorAll('.content .nav-tabs');
  if (navTabsGroups.length === 0) return;
  const lastNav = navTabsGroups[navTabsGroups.length - 1];

  const wrap = document.createElement('div');
  wrap.id = 'searchBarWrap';
  wrap.innerHTML = `<input type="text" id="globalSearch" placeholder="🔍 Search customer, address, dumpster ID…" autocomplete="off" />`;
  lastNav.insertAdjacentElement('afterend', wrap);

  document.getElementById('globalSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('.job, .aging-row').forEach((card) => {
      const text = card.textContent.toLowerCase();
      card.style.display = (!q || text.includes(q)) ? '' : 'none';
    });
  });
}

function requireAuth(onSuccess) {
  const role = getRole();
  if (role) {
    injectTopBar();
    injectSearchBar();
    onSuccess(role);
    return;
  }

  const overlay = document.createElement('div');
  overlay.id = 'authOverlay';
  overlay.innerHTML = `
    <div class="auth-box">
      <img src="logo.jpeg" alt="Oak & Pallet Disposal Corporation" />
      <p>Enter PIN</p>
      <input type="password" inputmode="numeric" id="authPin" placeholder="PIN" autocomplete="off" />
      <button id="authSubmit">Enter</button>
      <div id="authError"></div>
    </div>
  `;
  document.body.appendChild(overlay);

  document.getElementById('authSubmit').addEventListener('click', submit);
  document.getElementById('authPin').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  document.getElementById('authPin').focus();

  async function submit() {
    const pin = document.getElementById('authPin').value;
    const errEl = document.getElementById('authError');
    errEl.textContent = '';
    try {
      const res = await fetch('/api/verify-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin }),
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem('op_role', data.role);
        overlay.remove();
        injectTopBar();
        injectSearchBar();
        onSuccess(data.role);
      } else {
        errEl.textContent = 'Incorrect PIN';
        document.getElementById('authPin').value = '';
      }
    } catch (e) {
      errEl.textContent = 'Could not verify PIN — check connection.';
    }
  }
}
