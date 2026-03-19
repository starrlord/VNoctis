const API_BASE = '/api/v1';
const TOKEN_KEY = 'vnm-token';

/**
 * Returns the stored auth token, or null.
 */
function getToken() {
  return localStorage.getItem(TOKEN_KEY);
}

/**
 * Builds the default headers for a request, including auth token if present.
 * @param {Record<string,string>} [extra] Additional headers
 * @returns {Record<string,string>}
 */
function authHeaders(extra = {}) {
  const headers = { ...extra };
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  return headers;
}

/**
 * Handles the fetch Response, parsing JSON and throwing on HTTP errors.
 * On 401, clears stored token and redirects to /login.
 * @param {Response} response
 * @returns {Promise<any>}
 */
async function handleResponse(response) {
  if (response.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    // Redirect to login if not already there
    if (!window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('Session expired');
  }

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = await response.json();
      if (body.error) message = body.error;
      else if (body.message) message = body.message;
    } catch {
      // ignore parse errors — use status text
    }
    throw new Error(message);
  }

  // 204 No Content — nothing to parse
  if (response.status === 204) return null;

  return response.json();
}

/**
 * Simple fetch wrapper for the VNoctis Manager API.
 * All paths are relative to /api/v1 (e.g., pass "/library" not "/api/v1/library").
 * Automatically attaches auth token and handles 401 redirects.
 */
const api = {
  /**
   * @param {string} path
   * @returns {Promise<any>}
   */
  get(path) {
    return fetch(`${API_BASE}${path}`, {
      headers: authHeaders(),
    }).then(handleResponse);
  },

  /**
   * @param {string} path
   * @param {any} [body]
   * @returns {Promise<any>}
   */
  post(path, body) {
    return fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    }).then(handleResponse);
  },

  /**
   * @param {string} path
   * @param {any} [body]
   * @returns {Promise<any>}
   */
  put(path, body) {
    return fetch(`${API_BASE}${path}`, {
      method: 'PUT',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    }).then(handleResponse);
  },

  /**
   * @param {string} path
   * @param {any} [body]
   * @returns {Promise<any>}
   */
  patch(path, body) {
    return fetch(`${API_BASE}${path}`, {
      method: 'PATCH',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(body ?? {}),
    }).then(handleResponse);
  },

  /**
   * @param {string} path
   * @returns {Promise<any>}
   */
  delete(path) {
    return fetch(`${API_BASE}${path}`, {
      method: 'DELETE',
      headers: authHeaders(),
    }).then(handleResponse);
  },

  /**
   * Upload a file via multipart form data.
   * Note: Do NOT set Content-Type header — browser sets it with boundary automatically.
   * @param {string} path
   * @param {FormData} formData
   * @returns {Promise<any>}
   */
  upload(path, formData) {
    return fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: authHeaders(), // No Content-Type — browser handles it for FormData
      body: formData,
    }).then(handleResponse);
  },
};

export default api;
