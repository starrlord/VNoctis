const KEY = 'vnm-offline-session';
const hash = async (token) =>
  Array.from(
    new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token))
    ),
    (x) => x.toString(16).padStart(2, '0')
  ).join('');
export async function rememberOfflineSession(user, token) {
  if (localStorage.getItem('vnm-token') !== token) return;
  const fingerprint = await hash(token);
  if (localStorage.getItem('vnm-token') === token)
    localStorage.setItem(KEY, JSON.stringify({ fingerprint, user }));
}
export async function offlineSession(token) {
  try {
    const claim = JSON.parse(
      atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
    );
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (
      !Number.isFinite(claim.exp) ||
      claim.exp * 1000 <= Date.now() ||
      saved?.user?.userId !== claim.userId ||
      saved.fingerprint !== (await hash(token)) ||
      localStorage.getItem('vnm-token') !== token
    )
      return null;
    // Offline profiles can open their retained games, never administrative tools.
    return { ...saved.user, role: 'viewer' };
  } catch {
    return null;
  }
}
export function forgetOfflineSession() {
  localStorage.removeItem(KEY);
}
