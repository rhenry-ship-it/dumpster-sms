function requireAuth(role, onSuccess) {
  const key = role + '_authed';
  if (localStorage.getItem(key) === 'true') {
    onSuccess();
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
        body: JSON.stringify({ role, pin }),
      });
      const data = await res.json();
      if (data.ok) {
        localStorage.setItem(key, 'true');
        overlay.remove();
        onSuccess();
      } else {
        errEl.textContent = 'Incorrect PIN';
        document.getElementById('authPin').value = '';
      }
    } catch (e) {
      errEl.textContent = 'Could not verify PIN — check connection.';
    }
  }
}
