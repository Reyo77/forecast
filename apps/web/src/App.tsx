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
import { ProductsPage } from './features/masterdata/ProductsPage';
import { ProductDetailPage } from './features/masterdata/ProductDetailPage';
import { LocationsPage } from './features/masterdata/LocationsPage';
import { SuppliersPage } from './features/masterdata/SuppliersPage';
import { InventoryPage } from './features/masterdata/InventoryPage';
import { ImportPage } from './features/sales/ImportPage';
import { ExplorerPage } from './features/sales/ExplorerPage';
import { ForecastsPage } from './features/forecast/ForecastsPage';
import { ForecastRunPage } from './features/forecast/ForecastRunPage';
import { PricingPage } from './features/billing/PricingPage';
import { BillingPage } from './features/billing/BillingPage';
import { InvoicePage, InvoicesPage } from './features/billing/InvoicesPage';
import { MetricsPage } from './features/admin/MetricsPage';
import { TenantsPage } from './features/admin/TenantsPage';
import { TenantDetailPage } from './features/admin/TenantDetailPage';
import { PlansAdminPage } from './features/admin/PlansAdminPage';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/signup" element={<SignupPage />} />
        <Route path="/accept-invite" element={<AcceptInvitePage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/pricing" element={<PricingPage />} />
        <Route element={<ProtectedRoute />}>
          <Route element={<AppLayout />}>
            <Route path="/" element={<HomePage />} />
            <Route path="/change-password" element={<ChangePasswordPage />} />
            <Route element={<RequirePermission permission="masterdata:read" />}>
              <Route path="/products" element={<ProductsPage />} />
              <Route path="/products/:id" element={<ProductDetailPage />} />
              <Route path="/locations" element={<LocationsPage />} />
              <Route path="/suppliers" element={<SuppliersPage />} />
              <Route path="/inventory" element={<InventoryPage />} />
            </Route>
            <Route element={<RequirePermission permission="sales:read" />}>
              <Route path="/sales" element={<ExplorerPage />} />
            </Route>
            <Route element={<RequirePermission permission="import:sales" />}>
              <Route path="/import" element={<ImportPage />} />
            </Route>
            <Route element={<RequirePermission permission="forecast:read" />}>
              <Route path="/forecasts" element={<ForecastsPage />} />
              <Route path="/forecasts/:id" element={<ForecastRunPage />} />
            </Route>
            <Route element={<RequirePermission permission="team:read" />}>
              <Route path="/team" element={<TeamPage />} />
            </Route>
            <Route element={<RequirePermission permission="audit:read" />}>
              <Route path="/audit-log" element={<AuditLogPage />} />
            </Route>
            <Route element={<RequirePermission permission="billing:read" />}>
              <Route path="/billing" element={<BillingPage />} />
              <Route path="/billing/invoices" element={<InvoicesPage />} />
              <Route path="/billing/invoices/:id" element={<InvoicePage />} />
            </Route>
            <Route element={<RequirePermission permission="admin:access" />}>
              <Route path="/admin" element={<MetricsPage />} />
              <Route path="/admin/tenants" element={<TenantsPage />} />
              <Route path="/admin/tenants/:id" element={<TenantDetailPage />} />
              <Route path="/admin/plans" element={<PlansAdminPage />} />
            </Route>
          </Route>
        </Route>
      </Routes>
    </AuthProvider>
  );
}
