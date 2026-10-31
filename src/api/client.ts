import {
  RouterSummary,
  PppSecret,
  PppActive,
  PppProfile,
  SimpleQueue,
  IpPool,
  RouterConnectionTestResult,
  OverviewData,
  AuditLogItem,
  User,
  SessionTrafficInfo,
  SessionTrendResponse,
} from '../types/index.ts';

const TOKEN_KEY = 'pppoe_manager_jwt';

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function removeStoredToken() {
  localStorage.removeItem(TOKEN_KEY);
}

/** Error API dengan status HTTP, agar pemanggil dapat membedakan 401 (sesi habis) dari gangguan jaringan. */
export class ApiError extends Error {
  constructor(message: string, public status: number = 0) {
    super(message);
    this.name = 'ApiError';
  }
}

const REQUEST_TIMEOUT_MS = 30_000;
/** Request GET identik yang sedang berjalan digabung: banyak komponen/polling = satu panggilan jaringan. */
const inflightGets = new Map<string, Promise<unknown>>();

async function doRequest<T>(endpoint: string, options: RequestInit): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((options.headers as Record<string, string>) || {}),
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(endpoint, { ...options, headers, signal: controller.signal });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ApiError('Server tidak merespons (timeout). Coba lagi sebentar lagi.', 0);
    }
    throw new ApiError('Tidak dapat terhubung ke server. Periksa koneksi jaringan Anda.', 0);
  } finally {
    clearTimeout(timer);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    if (response.status === 401 && !endpoint.includes('/api/auth/login')) {
      removeStoredToken();
      window.dispatchEvent(new Event('auth:unauthorized'));
    }
    const message =
      data.error ||
      (response.status === 502 || response.status === 503 || response.status === 504
        ? 'Server sedang tidak tersedia. Coba lagi sebentar lagi.'
        : `Terjadi kesalahan (HTTP ${response.status})`);
    throw new ApiError(message, response.status);
  }

  return data;
}

function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') return doRequest<T>(endpoint, options);

  const existing = inflightGets.get(endpoint);
  if (existing) return existing as Promise<T>;
  const p = doRequest<T>(endpoint, options).finally(() => inflightGets.delete(endpoint));
  inflightGets.set(endpoint, p);
  return p;
}

export const api = {
  auth: {
    login: (credentials: { username: string; password: string }) =>
      request<{ success: boolean; token: string; user: User }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(credentials),
      }),
    me: () => request<{ success: boolean; user: User }>('/api/auth/me'),
    changePassword: (body: { currentPassword: string; newPassword: string }) =>
      request<{ success: boolean; message: string; token: string; user: User }>('/api/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(body),
      }),
  },

  routers: {
    getAll: () => request<{ success: boolean; data: RouterSummary[] }>('/api/routers'),
    create: (data: any) =>
      request<{ success: boolean; data: RouterSummary }>('/api/routers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: any) =>
      request<{ success: boolean; data: RouterSummary }>(`/api/routers/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ success: boolean; message: string }>(`/api/routers/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
    testConnection: (id: string) =>
      request<{ success: boolean; data: RouterConnectionTestResult }>(`/api/routers/${encodeURIComponent(id)}/test`, {
        method: 'POST',
      }),
  },

  secrets: {
    getAll: (routerId: string) =>
      request<{ success: boolean; data: PppSecret[]; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/secrets`
      ),
    create: (routerId: string, secret: Partial<PppSecret>) =>
      request<{ success: boolean; data: PppSecret }>(`/api/routers/${encodeURIComponent(routerId)}/ppp/secrets`, {
        method: 'POST',
        body: JSON.stringify(secret),
      }),
    update: (routerId: string, name: string, patch: Partial<PppSecret>) =>
      request<{ success: boolean; data: PppSecret }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/secrets/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(patch),
        }
      ),
    delete: (routerId: string, name: string) =>
      request<{ success: boolean; message: string }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/secrets/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      ),
    bulkAction: (routerId: string, body: { action: string; items: Array<{ name: string; routerId?: string }>; targetProfile?: string }) =>
      request<{ success: boolean; successCount: number; total: number; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/secrets/bulk-action`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
  },

  active: {
    getAll: (routerId: string) =>
      request<{ success: boolean; data: PppActive[]; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active`
      ),
    disconnect: (routerId: string, name: string, targetRouterId?: string) =>
      request<{ success: boolean; message: string }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active/${encodeURIComponent(name)}${
          targetRouterId ? `?routerId=${encodeURIComponent(targetRouterId)}` : ''
        }`,
        {
          method: 'DELETE',
        }
      ),
    bulkDisconnect: (routerId: string, items: Array<{ name: string; routerId?: string }>) =>
      request<{ success: boolean; disconnectedCount: number }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active/bulk-disconnect`,
        {
          method: 'POST',
          body: JSON.stringify({ items }),
        }
      ),
    getHistory: (routerId: string, name: string) =>
      request<{ success: boolean; data: Array<{ id: string; timestamp: string; type: 'connected' | 'disconnected'; username: string; routerName: string; ipAddress: string; details?: string }> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active/${encodeURIComponent(name)}/history`
      ),
    getTraffic: (routerId: string, name: string, targetRouterId?: string) =>
      request<{ success: boolean; data: SessionTrafficInfo }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active/${encodeURIComponent(name)}/traffic${
          targetRouterId ? `?routerId=${encodeURIComponent(targetRouterId)}` : ''
        }`
      ),
    ping: (routerId: string, body: { address: string; count?: number; size?: number; targetRouterId?: string }) =>
      request<{
        success: boolean;
        data: {
          target: string;
          routerName: string;
          sent: number;
          received: number;
          lost: number;
          packetLoss: number;
          minRtt: number;
          avgRtt: number;
          maxRtt: number;
          packets: Array<{
            seq: number;
            host: string;
            size: number;
            ttl: number;
            timeMs: number;
            status: 'reply' | 'timeout';
          }>;
          timestamp: number;
        };
      }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/active/ping${
          body.targetRouterId ? `?routerId=${encodeURIComponent(body.targetRouterId)}` : ''
        }`,
        {
          method: 'POST',
          body: JSON.stringify({ address: body.address, count: body.count, size: body.size }),
        }
      ),
  },

  profiles: {
    getAll: (routerId: string) =>
      request<{ success: boolean; data: PppProfile[]; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/profiles`
      ),
    create: (routerId: string, profile: Partial<PppProfile>) =>
      request<{ success: boolean; data: PppProfile }>(`/api/routers/${encodeURIComponent(routerId)}/ppp/profiles`, {
        method: 'POST',
        body: JSON.stringify(profile),
      }),
    update: (routerId: string, name: string, patch: Partial<PppProfile>) =>
      request<{ success: boolean; data: PppProfile }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/profiles/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(patch),
        }
      ),
    delete: (routerId: string, name: string) =>
      request<{ success: boolean; message: string }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/profiles/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      ),
    bulkAction: (
      routerId: string,
      body: {
        action: 'change_dns' | 'change_rate_limit' | 'change_local_address' | 'change_remote_address' | 'delete';
        items: Array<{ name: string; routerId?: string }>;
        dnsServer?: string;
        rateLimit?: string;
        localAddress?: string;
        remoteAddress?: string;
      }
    ) =>
      request<{ success: boolean; successCount: number; total: number; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ppp/profiles/bulk-action`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      ),
  },

  queues: {
    getAll: (routerId: string) =>
      request<{ success: boolean; data: SimpleQueue[]; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/queues`
      ),
    create: (routerId: string, queue: Partial<SimpleQueue>) =>
      request<{ success: boolean; data: SimpleQueue }>(`/api/routers/${encodeURIComponent(routerId)}/queues`, {
        method: 'POST',
        body: JSON.stringify(queue),
      }),
    update: (routerId: string, name: string, patch: Partial<SimpleQueue>) =>
      request<{ success: boolean; data: SimpleQueue }>(
        `/api/routers/${encodeURIComponent(routerId)}/queues/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(patch),
        }
      ),
    delete: (routerId: string, name: string) =>
      request<{ success: boolean; message: string }>(
        `/api/routers/${encodeURIComponent(routerId)}/queues/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      ),
  },

  pools: {
    getAll: (routerId: string) =>
      request<{ success: boolean; data: IpPool[]; errors?: Record<string, string> }>(
        `/api/routers/${encodeURIComponent(routerId)}/ip-pools`
      ),
    create: (routerId: string, pool: Partial<IpPool>) =>
      request<{ success: boolean; data: IpPool }>(`/api/routers/${encodeURIComponent(routerId)}/ip-pools`, {
        method: 'POST',
        body: JSON.stringify(pool),
      }),
    update: (routerId: string, name: string, patch: Partial<IpPool>) =>
      request<{ success: boolean; data: IpPool }>(
        `/api/routers/${encodeURIComponent(routerId)}/ip-pools/${encodeURIComponent(name)}`,
        {
          method: 'PUT',
          body: JSON.stringify(patch),
        }
      ),
    delete: (routerId: string, name: string) =>
      request<{ success: boolean; message: string }>(
        `/api/routers/${encodeURIComponent(routerId)}/ip-pools/${encodeURIComponent(name)}`,
        {
          method: 'DELETE',
        }
      ),
  },

  overview: {
    get: () => request<{ success: boolean; data: OverviewData }>('/api/overview'),
    getTrends: (range: string = '24h') =>
      request<{ success: boolean; data: SessionTrendResponse }>(
        `/api/overview/trends?range=${encodeURIComponent(range)}`
      ),
  },

  audit: {
    getAll: () => request<{ success: boolean; data: AuditLogItem[] }>('/api/audit-logs'),
    resetDemo: () => request<{ success: boolean; message: string }>('/api/demo/reset-demo', { method: 'POST' }),
  },

  users: {
    getAll: () => request<{ success: boolean; data: User[] }>('/api/users'),
    create: (data: Partial<User> & { password?: string }) =>
      request<{ success: boolean; data: User }>('/api/users', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<User> & { password?: string }) =>
      request<{ success: boolean; data: User }>(`/api/users/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ success: boolean; message: string }>(`/api/users/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      }),
  },
};
