import type {
  CreateInviteInput,
  Paged,
  TeamInvite,
  TeamUser,
  UpdateUserInput,
} from '@supplycast/shared';
import { api } from '../../api/client';

export const teamApi = {
  users: () => api<Paged<TeamUser>>('/users?pageSize=100'),
  invites: () => api<Paged<TeamInvite>>('/invites?pageSize=100'),
  invite: (input: CreateInviteInput) =>
    api<{ invite: TeamInvite; link: string }>('/invites', 'POST', input),
  revokeInvite: (id: string) => api<void>(`/invites/${id}`, 'DELETE'),
  updateUser: (id: string, input: UpdateUserInput) =>
    api<{ user: TeamUser }>(`/users/${id}`, 'PATCH', input),
  resetLink: (id: string) =>
    api<{ link: string; expiresAt: string }>(`/users/${id}/reset-link`, 'POST'),
  transferOwnership: (userId: string, password: string) =>
    api<{ ok: true }>('/tenant/transfer-ownership', 'POST', { userId, password }),
};
