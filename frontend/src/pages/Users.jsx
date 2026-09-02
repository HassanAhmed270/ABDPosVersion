import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import Sidebar from '../components/Sidebar';
import Topbar from '../components/Topbar';
import { api } from '../lib/api';
import { useAuth } from '../lib/AuthContext';
import { useConfirm } from '../components/ConfirmDialog';

const emptyCreateForm = { username: '', password: '', role: 'cashier' };

export default function Users() {
  const { username: myUsername } = useAuth();
  const confirm = useConfirm();
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [createForm, setCreateForm] = useState(emptyCreateForm);
  const [resetTarget, setResetTarget] = useState(null);
  const [resetPassword, setResetPassword] = useState('');

  const loadUsers = async () => {
    setLoading(true);
    try {
      const data = await api.getUsers();
      setUsers(data.users || []);
      setError('');
    } catch (err) {
      setError(err.message || 'Failed to load users');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!createForm.username.trim()) {
      toast.error('Username is required.');
      return;
    }
    if (createForm.password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    try {
      await api.createUser(createForm);
      setCreateForm(emptyCreateForm);
      await loadUsers();
    } catch (err) {
      toast.error('Error creating worker: ' + err.message);
    }
  };

  const handleDelete = async (u) => {
    if (!(await confirm(`Delete worker ${u.username}? This cannot be undone.`))) return;
    try {
      await api.deleteUser(u.username);
      await loadUsers();
    } catch (err) {
      toast.error('Failed to delete worker: ' + err.message);
    }
  };

  const handleResetPassword = async (e) => {
    e.preventDefault();
    if (resetPassword.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    try {
      await api.resetUserPassword(resetTarget.username, resetPassword);
      toast.success(`Password reset for ${resetTarget.username}. They will need to log in again.`);
      setResetTarget(null);
      setResetPassword('');
    } catch (err) {
      toast.error('Failed to reset password: ' + err.message);
    }
  };

  return (
    <div className="flex h-screen">
      <Sidebar />
      <main className="flex-1 flex flex-col overflow-hidden">
        <Topbar title="Workers" />
        <div className="p-4 @min-[768px]:p-6 overflow-y-auto flex-1 space-y-6">
          {error && <p className="text-red-600 text-sm">{error}</p>}

          <div className="bg-white border rounded-lg w-full">
            <div className="flex flex-col @min-[1024px]:flex-row">
              <div className="w-full @min-[1024px]:w-2/3 overflow-x-auto">
                <table className="w-full min-w-[480px] text-sm">
                  <thead>
                    <tr className="border-b bg-gray-100">
                      <th className="py-3 px-2 text-left">Username</th>
                      <th className="py-3 px-2 text-left">Role</th>
                      <th className="py-3 px-2 text-left">Added</th>
                      <th className="py-3 px-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {loading ? (
                      <tr><td colSpan={4} className="py-6 text-center text-gray-400">Loading…</td></tr>
                    ) : users.length === 0 ? (
                      <tr><td colSpan={4} className="py-6 text-center text-gray-400">No workers found</td></tr>
                    ) : (
                      users.map((u) => (
                        <tr key={u.username} className="border-b hover:bg-gray-50">
                          <td className="py-2 px-3">
                            {u.username}
                            {u.username === myUsername && <span className="text-xs text-gray-400 ml-1">(you)</span>}
                          </td>
                          <td className="py-2 px-3 capitalize">{u.role}</td>
                          <td className="py-2 px-3">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '—'}</td>
                          <td className="py-2 px-3 space-x-3">
                            <button
                              onClick={() => { setResetTarget(u); setResetPassword(''); }}
                              className="text-brand hover:underline"
                            >
                              Reset password
                            </button>
                            {u.username !== myUsername && (
                              <button
                                onClick={() => handleDelete(u)}
                                className="text-red-600 hover:text-red-800"
                                title="Delete"
                              >
                                🗑️
                              </button>
                            )}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <div className="w-full @min-[1024px]:w-1/3 p-4 @min-[640px]:p-6 border-t-4 @min-[1024px]:border-t-0 @min-[1024px]:border-l-4 border-gray-300">
                <h2 className="text-xl flex justify-center text-blue-600 font-bold mb-4">Add Worker</h2>
                <form onSubmit={handleCreate} className="space-y-3 text-sm">
                  <input
                    type="text"
                    value={createForm.username}
                    onChange={(e) => setCreateForm({ ...createForm, username: e.target.value })}
                    placeholder="Username"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <input
                    type="password"
                    value={createForm.password}
                    onChange={(e) => setCreateForm({ ...createForm, password: e.target.value })}
                    placeholder="Password (min 8 characters)"
                    className="border rounded px-3 py-2 w-full"
                  />
                  <select
                    value={createForm.role}
                    onChange={(e) => setCreateForm({ ...createForm, role: e.target.value })}
                    className="border rounded px-3 py-2 w-full"
                  >
                    <option value="cashier">Cashier</option>
                    <option value="admin">Admin</option>
                  </select>
                  <button type="submit" className="w-full px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700">
                    Add Worker
                  </button>
                </form>
              </div>
            </div>
          </div>

          {resetTarget && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" onClick={() => setResetTarget(null)}>
              <div className="bg-white rounded-lg p-6 w-full max-w-sm" onClick={(e) => e.stopPropagation()}>
                <h3 className="text-lg font-bold mb-3">Reset password for {resetTarget.username}</h3>
                <form onSubmit={handleResetPassword} className="space-y-3 text-sm">
                  <input
                    type="password"
                    value={resetPassword}
                    onChange={(e) => setResetPassword(e.target.value)}
                    placeholder="New password (min 8 characters)"
                    className="border rounded px-3 py-2 w-full"
                    autoFocus
                  />
                  <div className="flex gap-2">
                    <button type="submit" className="flex-1 px-4 py-2 bg-brand text-white rounded hover:bg-brand-dark">
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => setResetTarget(null)}
                      className="flex-1 px-4 py-2 border rounded hover:bg-gray-50"
                    >
                      Cancel
                    </button>
                  </div>
                  <p className="text-xs text-gray-500">
                    This immediately signs the worker out of any active session.
                  </p>
                </form>
              </div>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
