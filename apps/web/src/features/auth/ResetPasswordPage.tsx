import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { passwordSchema } from '@supplycast/shared';
import { api } from '../../api/client';
import { Field } from '../../components/Field';
import { AuthLayout, FormError, Submit } from '../../components/AuthLayout';

const formSchema = z.object({ newPassword: passwordSchema });
type Form = z.infer<typeof formSchema>;

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const token = params.get('token');
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<Form>({ resolver: zodResolver(formSchema) });

  if (!token) {
    return (
      <AuthLayout title="Reset password">
        <FormError message="This reset link is missing its token." />
      </AuthLayout>
    );
  }
  if (done) {
    return (
      <AuthLayout title="Password updated">
        <p role="status" className="text-sm text-green-700">
          Your password was changed.
        </p>
        <Link to="/login" className="mt-4 inline-block text-sm text-blue-600 underline">
          Go to log in
        </Link>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout title="Reset password">
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (v) => {
          setError(null);
          try {
            await api('/auth/reset-password', 'POST', { token, newPassword: v.newPassword });
            setDone(true);
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          registration={register('newPassword')}
          error={errors.newPassword?.message}
        />
        <Submit busy={isSubmitting}>Set new password</Submit>
      </form>
    </AuthLayout>
  );
}
