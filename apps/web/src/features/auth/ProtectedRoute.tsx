import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { LandingPage } from '../marketing/LandingPage';
import { useAuth } from './AuthContext';

export function ProtectedRoute() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading) return <p className="p-8 text-gray-500">Loading…</p>;
  // Visitors who aren't logged in see the marketing page at the root, a login redirect elsewhere.
  if (!user && location.pathname === '/') return <LandingPage />;
  if (!user) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <Outlet />;
}
