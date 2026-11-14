(() => {
  const $ = id => document.getElementById(id);
  let mode = 'login';
  let universities = [];
  const setNotice = (id, message, error = false) => {
    const el = $(id); el.textContent = message; el.classList.toggle('error', error);
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) } });
    const data = response.status === 204 ? null : await response.json();
    if (!response.ok) throw new Error(data?.error || 'Request failed. Please try again.');
    return data;
  }
  function showMode(next) {
    mode = next;
    $('loginTab').classList.toggle('active', mode === 'login');
    $('registerTab').classList.toggle('active', mode === 'register');
    $('nameField').classList.toggle('hidden', mode !== 'register');
    $('password').autocomplete = mode === 'register' ? 'new-password' : 'current-password';
    $('authSubmit').textContent = mode === 'register' ? 'Create account' : 'Sign in';
    setNotice('authNotice', '');
  }
  function showProfile(user) {
    $('authCard').classList.add('hidden');
    $('profileCard').classList.remove('hidden');
    $('welcome').textContent = `Welcome, ${user.displayName}`;
    $('profileEmail').textContent = user.email;
    $('profileName').value = user.displayName;
    $('targetUniversity').value = user.targetUniversity || '';
    $('personalExamDate').value = user.personalExamDate || '';
    $('studyGoal').value = user.studyGoalMinutes ?? 120;
  }
  async function loadUser() {
    const { user } = await api('/api/auth/me');
    if (user) showProfile(user);
  }
  async function loadUniversities() {
    const { user } = await api('/api/auth/me');
    const response = await fetch('/api/sources');
    if (!response.ok) throw new Error('Could not load universities.');
    universities = await response.json();
    $('targetUniversity').innerHTML = '<option value="">Not selected</option>' + universities.map(u => `<option value="${String(u.id).replace(/[&<>"']/g, '')}">${String(u.name).replace(/[&<>"']/g, '')}</option>`).join('');
    if (user) showProfile(user);
  }
  $('loginTab').addEventListener('click', () => showMode('login'));
  $('registerTab').addEventListener('click', () => showMode('register'));
  $('authForm').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('authSubmit'); submit.disabled = true;
    setNotice('authNotice', mode === 'register' ? 'Creating account…' : 'Signing in…');
    try {
      const payload = { email: $('email').value.trim(), password: $('password').value };
      if (mode === 'register') payload.displayName = $('displayName').value.trim();
      const { user } = await api(`/api/auth/${mode === 'register' ? 'register' : 'login'}`, { method: 'POST', body: JSON.stringify(payload) });
      showProfile(user);
      $('password').value = '';
    } catch (error) { setNotice('authNotice', error.message, true); }
    finally { submit.disabled = false; }
  });
  $('profileForm').addEventListener('submit', async event => {
    event.preventDefault();
    const submit = $('profileForm').querySelector('button[type="submit"]'); submit.disabled = true;
    setNotice('profileNotice', 'Saving…');
    try {
      const payload = { displayName: $('profileName').value.trim(), targetUniversity: $('targetUniversity').value, personalExamDate: $('personalExamDate').value || null, studyGoalMinutes: Number($('studyGoal').value) };
      const { user } = await api('/api/profile', { method: 'PUT', body: JSON.stringify(payload) });
      showProfile(user); setNotice('profileNotice', 'Profile saved.');
    } catch (error) { setNotice('profileNotice', error.message, true); }
    finally { submit.disabled = false; }
  });
  $('logout').addEventListener('click', async () => {
    try { await api('/api/auth/logout', { method: 'POST' }); $('profileCard').classList.add('hidden'); $('authCard').classList.remove('hidden'); $('authForm').reset(); showMode('login'); }
    catch (error) { setNotice('profileNotice', error.message, true); }
  });
  Promise.all([loadUser(), loadUniversities()]).catch(error => setNotice('authNotice', error.message, true));
})();
