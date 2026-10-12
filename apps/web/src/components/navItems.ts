import type { Permission } from '@supplycast/shared';

export interface NavItem {
  to: string;
  label: string;
  permission: Permission;
  group: string;
  icon: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: 'Home', permission: 'dashboard:read', group: 'Overview', icon: 'home' },
  { to: '/products', label: 'Products', permission: 'masterdata:read', group: 'Data', icon: 'box' },
  {
    to: '/locations',
    label: 'Locations',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'pin',
  },
  {
    to: '/suppliers',
    label: 'Suppliers',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'truck',
  },
  {
    to: '/inventory',
    label: 'Inventory',
    permission: 'masterdata:read',
    group: 'Data',
    icon: 'stack',
  },
  { to: '/sales', label: 'Sales', permission: 'sales:read', group: 'Demand', icon: 'chart' },
  { to: '/abc', label: 'ABC analysis', permission: 'sales:read', group: 'Demand', icon: 'chart' },
  { to: '/import', label: 'Import', permission: 'import:sales', group: 'Demand', icon: 'upload' },
  {
    to: '/forecasts',
    label: 'Forecasts',
    permission: 'forecast:read',
    group: 'Planning',
    icon: 'trend',
  },
  {
    to: '/reorder',
    label: 'Reorder plan',
    permission: 'forecast:read',
    group: 'Planning',
    icon: 'list',
  },
  {
    to: '/scenarios',
    label: 'Scenarios',
    permission: 'scenario:read',
    group: 'Planning',
    icon: 'flask',
  },
  { to: '/team', label: 'Team', permission: 'team:read', group: 'Workspace', icon: 'users' },
  {
    to: '/billing',
    label: 'Billing',
    permission: 'billing:read',
    group: 'Workspace',
    icon: 'card',
  },
  {
    to: '/audit-log',
    label: 'Audit log',
    permission: 'audit:read',
    group: 'Workspace',
    icon: 'shield',
  },
  { to: '/admin', label: 'Overview', permission: 'admin:access', group: 'Platform', icon: 'home' },
  {
    to: '/admin/tenants',
    label: 'Tenants',
    permission: 'admin:access',
    group: 'Platform',
    icon: 'building',
  },
  {
    to: '/admin/plans',
    label: 'Plans',
    permission: 'admin:access',
    group: 'Platform',
    icon: 'card',
  },
];
