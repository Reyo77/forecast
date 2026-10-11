import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link } from 'react-router-dom';
import { changePasswordSchema, type ChangePasswordInput } from '@supplycast/shared';
import { Field } from '../../components/Field';
import { AuthLayout, FormError, Submit } from '../../components/AuthLayout';
import { useAuth } from './AuthContext';

export function ChangePasswordPage() {
  const { changePassword } = useAuth();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const {
    register,
    handleSubmit,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<ChangePasswordInput>({ resolver: zodResolver(changePasswordSchema) });

  return (
    <AuthLayout title="Change password">
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (values) => {
          setError(null);
          setDone(false);
          try {
            await changePassword(values);
            reset();
            setDone(true);
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        {done && (
          <p role="status" className="rounded bg-green-50 p-2 text-sm text-green-700">
            Password changed. Other sessions were signed out.
          </p>
        )}
        <Field
          label="Current password"
          type="password"
          autoComplete="current-password"
          registration={register('currentPassword')}
          error={errors.currentPassword?.message}
        />
        <Field
          label="New password"
          type="password"
          autoComplete="new-password"
          registration={register('newPassword')}
          error={errors.newPassword?.message}
        />
        <Submit busy={isSubmitting}>Change password</Submit>
      </form>
      <Link to="/" className="mt-4 inline-block text-sm text-blue-600 underline">
        Back to home
      </Link>
    </AuthLayout>
  );
}
