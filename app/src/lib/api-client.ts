import { supabase } from './supabase';

const DEPLOYED_APP_ORIGIN = 'https://surevideotool-project.vercel.app';
const LOCAL_API_BASE = '/api';

function normalizeApiBase(value?: string | null): string | null {
  if (!value) return null;

  const trimmed = value.trim().replace(/\/+$/, '');
  if (!trimmed) return null;

  return trimmed.endsWith('/api') ? trimmed : `${trimmed}/api`;
}

function isFileProtocol(): boolean {
  return typeof window !== 'undefined' && (window.location.protocol === 'file:' || Boolean(window.electron));
}

function getApiBase(): string {
  if (import.meta.env.DEV) {
    return LOCAL_API_BASE;
  }

  const configuredBase = normalizeApiBase(import.meta.env.VITE_API_URL);

  if (configuredBase && configuredBase.startsWith('/') && isFileProtocol()) {
    return `${DEPLOYED_APP_ORIGIN}/api`;
  }

  return configuredBase || `${DEPLOYED_APP_ORIGIN}/api`;
}

function withLeadingSlash(path: string): string {
  return path.startsWith('/') ? path : `/${path}`;
}

export async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const normalizedPath = withLeadingSlash(path);
  const apiBase = getApiBase();
  const headers = new Headers(init?.headers);
  const { data: { session } } = await supabase.auth.getSession();
  if (session) headers.set('Authorization', `Bearer ${session.access_token}`);
  return fetch(`${apiBase}${normalizedPath}`, { ...init, headers });
}
