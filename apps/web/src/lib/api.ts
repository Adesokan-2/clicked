/**
 * Single source of truth for the backend base URL.
 *
 * NEXT_PUBLIC_BACKEND_URL is the canonical variable.
 *
 * @deprecated NEXT_PUBLIC_API_URL and NEXT_PUBLIC_SOCKET_URL are deprecated
 * fallbacks, kept for one release. Migrate to NEXT_PUBLIC_BACKEND_URL.
 */
const RAW_BACKEND_URL =
  process.env.NEXT_PUBLIC_BACKEND_URL ||
  // @deprecated: remove after one release, use NEXT_PUBLIC_BACKEND_URL
  process.env.NEXT_PUBLIC_API_URL ||
  // @deprecated: remove after one release, use NEXT_PUBLIC_BACKEND_URL
  process.env.NEXT_PUBLIC_SOCKET_URL ||
  'http://localhost:3001';

export const BACKEND_URL = RAW_BACKEND_URL.replace(/\/$/, '');

/** @deprecated Use BACKEND_URL. Retained as an alias for one release. */
export const API_BASE_URL = BACKEND_URL;

export async function apiFetch(path: string, init: RequestInit = {}) {
  return fetch(`${BACKEND_URL}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...init.headers,
    },
  });
}
