/** Bearer JWT session helpers — localStorage only, no cookies. */

export function applySessionResponse(data, { onToken, onUser } = {}) {
  if (data?.token) {
    localStorage.setItem('token', data.token);
    onToken?.(data.token);
  }
  if (data?.user) {
    localStorage.setItem('user', JSON.stringify(data.user));
    onUser?.(data.user);
  }
}

export async function fetchMe(token) {
  return fetch('/auth/me', { headers: { Authorization: 'Bearer ' + token } });
}

/** Validate session on load; returns user or throws on hard auth failure. */
export async function validateSession(token, { onToken, onUser } = {}) {
  const res = await fetchMe(token);
  if (!res.ok) {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    location.href = 'login.html';
    throw new Error('Invalid token');
  }
  const data = await res.json();
  applySessionResponse(data, { onToken, onUser });
  return data.user;
}

/** Sliding JWT refresh while the tab stays open — avoids mid-session expiry. */
export function startSessionKeepalive(getToken, { onToken, onUser, intervalMs = 30 * 60 * 1000 } = {}) {
  setInterval(async () => {
    const token = getToken();
    if (!token) return;
    try {
      const res = await fetchMe(token);
      if (res.ok) {
        const data = await res.json();
        applySessionResponse(data, { onToken, onUser });
        return;
      }
      if (res.status === 401) {
        localStorage.removeItem('token');
        localStorage.removeItem('user');
        location.href = 'login.html';
      }
    } catch (_) {
      // Network blip — keep using current token until next interval
    }
  }, intervalMs);
}
