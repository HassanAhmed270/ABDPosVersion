import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/AuthContext';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      const user = await login(username.trim(), password);
      navigate(user.role === 'admin' ? '/dashboard' : '/billing');
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen w-screen flex items-center justify-center bg-linear-to-br from-brand via-[#0a6ea6] to-[#e6f2f9] relative px-4 py-10">
      <div className="absolute inset-0 grid grid-rows-2 -z-0">
        <div className="bg-brand flex justify-center px-4 @min-[640px]:px-10 text-center">
          <h1 className="text-3xl @min-[640px]:text-4xl @min-[768px]:text-5xl mt-14 @min-[640px]:mt-20 font-extrabold text-white">Billing Management</h1>
        </div>
        <div className="bg-[#f4f9fc]" />
      </div>

      <div className="relative bg-white shadow-2xl rounded-2xl w-full max-w-sm @min-[640px]:max-w-md p-6 @min-[640px]:p-8 z-10">
        <div className="text-center mb-6">
          <h2 className="text-3xl font-extrabold text-brand">Login</h2>
          <p className="text-gray-500 text-sm">Access your account</p>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="mb-4">
            <label className="block text-gray-600 mb-2">Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="Enter username"
              required
            />
          </div>

          <div className="mb-4">
            <label className="block text-gray-600 mb-2">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border rounded-lg focus:outline-none focus:ring-2 focus:ring-brand"
              placeholder="Enter password"
              required
            />
          </div>

          {error && <p className="text-red-600 text-sm mb-4">{error}</p>}

          <button
            type="submit"
            disabled={submitting}
            className="w-full bg-brand hover:bg-brand-dark text-white font-semibold py-2 px-4 rounded-lg shadow-md transition transform hover:scale-[1.02] disabled:opacity-60 disabled:hover:scale-100"
          >
            {submitting ? 'Signing in…' : '🚀 Login'}
          </button>
        </form>
      </div>
    </div>
  );
}