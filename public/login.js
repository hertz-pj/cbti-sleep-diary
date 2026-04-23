(function () {
  const tabLogin = document.getElementById('tabLogin');
  const tabRegister = document.getElementById('tabRegister');
  const submitBtn = document.getElementById('submitBtn');
  const form = document.getElementById('authForm');
  const msg = document.getElementById('msg');
  const usernameInput = document.getElementById('username');
  const passwordInput = document.getElementById('password');

  let mode = 'login';
  let allowRegister = true;

  // 拉服务端配置：是否开放注册
  fetch('/api/config').then(r => r.json()).then(c => {
    allowRegister = !!c.allowRegister;
    if (!allowRegister) tabRegister.style.display = 'none';
  }).catch(() => {});

  function setMode(next) {
    mode = next;
    tabLogin.classList.toggle('active', mode === 'login');
    tabRegister.classList.toggle('active', mode === 'register');
    submitBtn.textContent = mode === 'login' ? '登 录' : '注 册';
    passwordInput.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    showMsg('', '');
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabRegister.addEventListener('click', () => {
    if (!allowRegister) {
      showMsg('注册已关闭，请联系管理员', 'error');
      return;
    }
    setMode('register');
  });

  function showMsg(text, kind) {
    msg.className = 'auth-msg' + (kind ? ' ' + kind : '');
    msg.textContent = text || '';
    if (!text) msg.style.display = 'none';
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showMsg('', '');
    submitBtn.disabled = true;
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    try {
      const url = mode === 'login' ? '/api/login' : '/api/register';
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '操作失败');
      showMsg(mode === 'login' ? '登录成功，跳转中…' : '注册成功，正在进入…', 'success');
      setTimeout(() => { window.location.href = '/app'; }, 400);
    } catch (err) {
      showMsg(err.message, 'error');
      submitBtn.disabled = false;
    }
  });
})();
