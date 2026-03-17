import { useState, useEffect, useCallback } from 'react';
import api from './useApi';

/**
 * Custom hook for user management (admin only).
 *
 * @returns {{
 *   users: Array,
 *   loading: boolean,
 *   error: string|null,
 *   refetch: () => void,
 *   createUser: (data: { username: string, password: string, role?: string }) => Promise<object>,
 *   updateUserRole: (userId: string, role: string) => Promise<void>,
 *   deleteUser: (userId: string) => Promise<void>,
 *   resetPassword: (userId: string, password: string) => Promise<void>,
 * }}
 */
export default function useUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchUsers = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.get('/users');
      setUsers(Array.isArray(data) ? data : []);
    } catch (err) {
      setError(err.message || 'Failed to fetch users');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  const createUser = useCallback(async ({ username, password, role }) => {
    const user = await api.post('/users', { username, password, role });
    setUsers((prev) => [...prev, { ...user, favoriteCount: 0 }]);
    return user;
  }, []);

  const updateUserRole = useCallback(async (userId, role) => {
    const updated = await api.patch(`/users/${userId}`, { role });
    setUsers((prev) =>
      prev.map((u) => (u.id === userId ? { ...u, role: updated.role } : u))
    );
  }, []);

  const deleteUser = useCallback(async (userId) => {
    await api.delete(`/users/${userId}`);
    setUsers((prev) => prev.filter((u) => u.id !== userId));
  }, []);

  const resetPassword = useCallback(async (userId, password) => {
    await api.post(`/users/${userId}/reset-password`, { password });
  }, []);

  return {
    users,
    loading,
    error,
    refetch: fetchUsers,
    createUser,
    updateUserRole,
    deleteUser,
    resetPassword,
  };
}
