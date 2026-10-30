import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { User } from '../types/index.ts';
import { api, ApiError, getStoredToken, setStoredToken, removeStoredToken } from '../api/client.ts';

interface AuthContextType {
  user: User | null;
  token: string | null;
  loading: boolean;
  login: (username: string, pass: string) => Promise<void>;
  changePassword: (currentPassword: string, newPassword: string) => Promise<void>;
  logout: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType>({
  user: null,
  token: null,
  loading: true,
  login: async () => {},
  changePassword: async () => {},
  logout: () => {},
  refreshUser: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [token, setToken] = useState<string | null>(getStoredToken());
  const [loading, setLoading] = useState(true);

  const logout = useCallback(() => {
    removeStoredToken();
    setToken(null);
    setUser(null);
  }, []);

  const refreshUser = useCallback(async () => {
    if (!getStoredToken()) {
      setUser(null);
      setLoading(false);
      return;
    }
    // Server yang sedang restart / jaringan putus sesaat TIDAK boleh mengeluarkan pengguna:
    // hanya 401 yang berarti sesi benar-benar tidak berlaku.
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const res = await api.auth.me();
        if (res.success && res.user) {
          setUser(res.user);
        } else {
          logout();
        }
        setLoading(false);
        return;
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          setLoading(false);
          return;
        }
        if (attempt < 3) await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
      }
    }
    setLoading(false); // tetap menyimpan token; pengguna dapat memuat ulang saat server pulih
  }, [logout]);

  useEffect(() => {
    refreshUser();

    const handleUnauthorized = () => {
      logout();
    };

    window.addEventListener('auth:unauthorized', handleUnauthorized);
    return () => window.removeEventListener('auth:unauthorized', handleUnauthorized);
  }, [refreshUser, logout]);

  const login = async (username: string, pass: string) => {
    const res = await api.auth.login({ username, password: pass });
    if (res.success && res.token) {
      setStoredToken(res.token);
      setToken(res.token);
      setUser(res.user);
    } else {
      throw new Error('Gagal masuk');
    }
  };

  const changePassword = async (currentPassword: string, newPassword: string) => {
    const res = await api.auth.changePassword({ currentPassword, newPassword });
    // Token lama dicabut server saat password berubah; simpan token baru agar sesi berlanjut.
    if (res.token) {
      setStoredToken(res.token);
      setToken(res.token);
    }
    if (res.user) setUser(res.user);
  };

  return (
    <AuthContext.Provider value={{ user, token, loading, login, changePassword, logout, refreshUser }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
