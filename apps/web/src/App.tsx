import { Route, Routes } from 'react-router-dom';
import { AuthProvider } from './features/auth/AuthContext';
import { ProtectedRoute } from './features/auth/ProtectedRoute';
import { RequirePermission } from './features/auth/RequirePermission';
import { LoginPage } from './features/auth/LoginPage';
import { SignupPage } from './features/auth/SignupPage';
import { AcceptInvitePage } from './features/auth/AcceptInvitePage';
import { ResetPasswordPage } from './features/auth/ResetPasswordPage';
import { ChangePasswordPage } from './features/auth/ChangePasswordPage';
import { AppLayout } from './components/AppLayout';
import { HomePage } from './routes/HomePage';
import { TeamPage } from './features/team/TeamPage';
import { AuditLogPage } from './features/audit/AuditLogPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route element={<RequirePermission permission="team:read" />}>
              <Route path="/team" element={<TeamPage />} />
            </Route>
            <Route element={<RequirePermission permission="audit:read" />}>
              <Route path="/audit-log" element={<AuditLogPage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
