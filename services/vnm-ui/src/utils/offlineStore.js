export const tokenUser = () => {
  try {
    const token = localStorage.getItem('vnm-token');
    return {
      token,
      userId: JSON.parse(
        atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
      ).userId,
    };
  } catch {
    return {};
  }
};
export function offlineStorage() {
  async function action(operation, key, value) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('vnm-offline-library', 1);
      request.onupgradeneeded = () =>
        request.result.createObjectStore('entries');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction(
            'entries',
            ['get', 'keys'].includes(operation) ? 'readonly' : 'readwrite'
          ),
          store = tx.objectStore('entries');
        const result =
          operation === 'put'
            ? store.put(value, key)
            : operation === 'keys'
              ? store.getAllKeys(IDBKeyRange.bound(key, key + '\uffff'))
              : store[operation](key);
        tx.oncomplete = () => {
          db.close();
          resolve(result.result);
        };
        tx.onabort = tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  }
  return {
    get: (key) => action('get', key),
    put: (key, value) => action('put', key, value),
    delete: (key) => action('delete', key),
    keys: (prefix) => action('keys', prefix),
  };
}
export const recordKey = (userId, gameId) =>
  `game:${encodeURIComponent(userId)}:${encodeURIComponent(gameId)}`;
export async function listOfflineGames(userId) {
  if (tokenUser().userId !== userId) throw Error('Account changed');
  const store = offlineStorage(),
    keys = await store.keys(`game:${encodeURIComponent(userId)}:`);
  const records = await Promise.all(keys.map((key) => store.get(key)));
  if (tokenUser().userId !== userId) throw Error('Account changed');
  return records.filter(Boolean);
}
export async function offlineGame(gameId) {
  const { userId, token } = tokenUser();
  if (!userId) return null;
  const record = await offlineStorage().get(recordKey(userId, gameId));
  if (tokenUser().token !== token) throw Error('Account changed');
  return record || null;
}
