import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { passwordSchema } from '@supplycast/shared';
import { Field } from '../../components/Field';
import { AuthLayout, FormError, Submit } from '../../components/AuthLayout';
import { useAuth } from './AuthContext';

const formSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  password: passwordSchema,
});
type Form = z.infer<typeof formSchema>;

export function AcceptInvitePage() {
  const { user, acceptInvite } = useAuth();
  const [params] = useSearchParams();
  const token = params.get('token');
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(formSchema) });

  if (user) return <Navigate to="/" replace />;
  if (!token) {
    return (
      <AuthLayout title="Accept invite">
        <FormError message="This invite link is missing its token." />
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Join your team">
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (v) => {
          setError(null);
          try {
            await acceptInvite({ token, ...v });
            navigate('/', { replace: true });
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        <Field
          label="Your name"
          autoComplete="name"
          registration={register('name')}
          error={errors.name?.message}
        />
        <Field
          label="Choose a password"
          type="password"
          autoComplete="new-password"
          registration={register('password')}
          error={errors.password?.message}
        />
        <p className="text-xs text-gray-500">At least 10 characters, with a letter and a number.</p>
        <Submit busy={isSubmitting}>Join team</Submit>
      </form>
    </AuthLayout>
  );
}
