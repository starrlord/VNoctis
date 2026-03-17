import { useState, useCallback } from 'react';
import useUsers from '../hooks/useUsers';
import useAuth from '../hooks/useAuth';
import CreateUserModal from '../components/CreateUserModal';
import ResetPasswordModal from '../components/ResetPasswordModal';
import StarBackground from '../components/StarBackground';

/**
 * Admin-only page for managing user accounts.
 * Lists users in a table with inline role-change, reset password, and delete actions.
 */
export default function UserManagement() {
  const { user: currentUser } = useAuth();
  const { users, loading, error, refetch, createUser, updateUserRole, deleteUser, resetPassword } = useUsers();
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [resetPasswordUser, setResetPasswordUser] = useState(null);
  const [deletingUserId, setDeletingUserId] = useState(null);
  const [actionError, setActionError] = useState(null);

  const handleRoleChange = useCallback(async (userId, newRole) => {
    setActionError(null);
    try {
      await updateUserRole(userId, newRole);
    } catch (err) {
      setActionError(err.message || 'Failed to update role');
    }
  }, [updateUserRole]);

  const handleDelete = useCallback(async (userId) => {
    setActionError(null);
    try {
      await deleteUser(userId);
      setDeletingUserId(null);
    } catch (err) {
      setActionError(err.message || 'Failed to delete user');
    }
  }, [deleteUser]);

  const handleCreate = useCallback(async (data) => {
    await createUser(data);
  }, [createUser]);

  const handleResetPassword = useCallback(async (userId, password) => {
    await resetPassword(userId, password);
  }, [resetPassword]);

  // Loading skeleton
  if (loading) {
    return (
      <>
        <StarBackground fixed darkOnly />
        <div className="relative z-10 max-w-5xl mx-auto p-6 space-y-6">
          <div className="flex items-center justify-between">
            <div className="h-8 w-64 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
            <div className="h-10 w-32 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
          </div>
          <div className="space-y-3">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-16 bg-gray-200 dark:bg-gray-800 rounded-lg animate-pulse" />
            ))}
          </div>
        </div>
      </>
    );
  }

  // Error state
  if (error) {
    return (
      <>
        <StarBackground fixed darkOnly />
        <div className="relative z-10 flex flex-col items-center justify-center min-h-[60vh] text-center px-6">
          <div className="text-red-400 mb-4">
            <svg className="w-16 h-16 mx-auto mb-3" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m9-.75a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9 3.75h.008v.008H12v-.008Z" />
            </svg>
            <p className="text-lg font-semibold">Failed to load users</p>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{error}</p>
          </div>
          <button
            onClick={refetch}
            className="px-5 py-2 bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg transition-colors duration-200"
          >
            Retry
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      <StarBackground fixed darkOnly />
      <div className="relative z-10 max-w-5xl mx-auto p-6 pb-[calc(1.5rem+env(safe-area-inset-bottom))] space-y-6">
        {/* Page header */}
        <div className="flex items-center justify-between">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 dark:text-white">
            👤 User Management
          </h1>
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white text-sm font-semibold rounded-lg transition-colors duration-200 shadow-lg shadow-emerald-600/20"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
            </svg>
            Create User
          </button>
        </div>

        {/* Action error banner */}
        {actionError && (
          <div className="rounded-lg bg-red-500/10 dark:bg-red-500/15 border border-red-500/20 px-4 py-3 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
            <svg className="w-5 h-5 flex-shrink-0 text-red-500" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" />
            </svg>
            <span>{actionError}</span>
            <button onClick={() => setActionError(null)} className="ml-auto text-red-400 hover:text-red-300 transition-colors">✕</button>
          </div>
        )}

        {/* Empty state */}
        {users.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-center">
            <svg className="w-16 h-16 text-gray-300 dark:text-gray-600 mb-4" fill="none" viewBox="0 0 24 24" strokeWidth={1} stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" />
            </svg>
            <p className="text-lg text-gray-500 dark:text-gray-400 font-medium">No users found</p>
            <p className="text-sm text-gray-400 dark:text-gray-500 mt-2">
              Create the first user account to get started.
            </p>
          </div>
        ) : (
          /* Users table */
          <div className="bg-white dark:bg-gray-800/50 rounded-xl border border-gray-200 dark:border-gray-700/50 shadow-lg overflow-hidden">
            {/* Table header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr_auto_auto_auto_auto] gap-4 px-5 py-3 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-700/50 text-xs font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              <span>User</span>
              <span className="w-24 text-center">Role</span>
              <span className="w-28 text-center">Created</span>
              <span className="w-20 text-center">Favorites</span>
              <span className="w-32 text-center">Actions</span>
            </div>

            {/* User rows */}
            <div className="divide-y divide-gray-100 dark:divide-gray-700/40">
              {users.map((user) => {
                const isSelf = user.id === currentUser?.userId;
                const isConfirmingDelete = deletingUserId === user.id;

                return (
                  <div
                    key={user.id}
                    className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto_auto] gap-3 sm:gap-4 px-5 py-4 items-center hover:bg-gray-50 dark:hover:bg-gray-800/40 transition-colors"
                  >
                    {/* Username */}
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-8 h-8 rounded-full bg-gradient-to-br from-blue-500 to-purple-600 flex items-center justify-center text-white text-sm font-bold flex-shrink-0">
                        {user.username.charAt(0).toUpperCase()}
                      </div>
                      <div className="min-w-0">
                        <span className="text-sm font-semibold text-gray-900 dark:text-white truncate block">
                          {user.username}
                          {isSelf && (
                            <span className="ml-2 text-xs font-medium text-blue-500 dark:text-blue-400">(you)</span>
                          )}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 sm:hidden">
                          {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                        </span>
                      </div>
                    </div>

                    {/* Role */}
                    <div className="w-24 flex justify-center">
                      {isSelf ? (
                        <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold ${
                          user.role === 'admin'
                            ? 'bg-purple-500/20 text-purple-400'
                            : 'bg-blue-500/20 text-blue-400'
                        }`}>
                          {user.role}
                        </span>
                      ) : (
                        <select
                          value={user.role}
                          onChange={(e) => handleRoleChange(user.id, e.target.value)}
                          className="px-2 py-1 rounded-lg text-xs font-semibold bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border border-gray-200 dark:border-gray-600 focus:outline-none focus:ring-2 focus:ring-blue-500/50 cursor-pointer transition-colors"
                        >
                          <option value="admin">admin</option>
                          <option value="viewer">viewer</option>
                        </select>
                      )}
                    </div>

                    {/* Created date */}
                    <div className="hidden sm:flex w-28 justify-center">
                      <span className="text-xs text-gray-500 dark:text-gray-400">
                        {user.createdAt ? new Date(user.createdAt).toLocaleDateString() : '—'}
                      </span>
                    </div>

                    {/* Favorite count */}
                    <div className="hidden sm:flex w-20 justify-center">
                      <span className="inline-flex items-center gap-1 text-xs text-gray-400 dark:text-gray-500">
                        <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor">
                          <path strokeLinecap="round" strokeLinejoin="round" d="M21 8.25c0-2.485-2.099-4.5-4.688-4.5-1.935 0-3.597 1.126-4.312 2.733-.715-1.607-2.377-2.733-4.313-2.733C5.1 3.75 3 5.765 3 8.25c0 7.22 9 12 9 12s9-4.78 9-12Z" />
                        </svg>
                        {user.favoriteCount ?? 0}
                      </span>
                    </div>

                    {/* Actions */}
                    <div className="w-32 flex items-center justify-center gap-1.5">
                      {isConfirmingDelete ? (
                        /* Inline delete confirmation */
                        <div className="flex items-center gap-1.5">
                          <span className="text-xs text-red-400 font-medium whitespace-nowrap">Delete?</span>
                          <button
                            onClick={() => handleDelete(user.id)}
                            className="px-2 py-1 text-xs font-semibold bg-red-600 hover:bg-red-500 text-white rounded-md transition-colors"
                          >
                            Yes
                          </button>
                          <button
                            onClick={() => setDeletingUserId(null)}
                            className="px-2 py-1 text-xs font-medium bg-gray-200 dark:bg-gray-700 hover:bg-gray-300 dark:hover:bg-gray-600 text-gray-700 dark:text-gray-300 rounded-md transition-colors"
                          >
                            No
                          </button>
                        </div>
                      ) : (
                        <>
                          {/* Reset password */}
                          <button
                            onClick={() => setResetPasswordUser(user)}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:text-amber-500 dark:hover:text-amber-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
                            title={`Reset password for ${user.username}`}
                          >
                            🔑
                          </button>

                          {/* Delete */}
                          <button
                            onClick={() => setDeletingUserId(user.id)}
                            disabled={isSelf}
                            className="w-8 h-8 flex items-center justify-center rounded-lg text-gray-500 dark:text-gray-400 hover:text-red-500 dark:hover:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-gray-500 dark:disabled:hover:text-gray-400 disabled:hover:bg-transparent transition-colors"
                            title={isSelf ? 'Cannot delete your own account' : `Delete ${user.username}`}
                          >
                            🗑️
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Create User modal */}
      {showCreateModal && (
        <CreateUserModal
          onClose={() => setShowCreateModal(false)}
          onCreate={handleCreate}
        />
      )}

      {/* Reset Password modal */}
      {resetPasswordUser && (
        <ResetPasswordModal
          userId={resetPasswordUser.id}
          username={resetPasswordUser.username}
          onClose={() => setResetPasswordUser(null)}
          onReset={handleResetPassword}
        />
      )}
    </>
  );
}
