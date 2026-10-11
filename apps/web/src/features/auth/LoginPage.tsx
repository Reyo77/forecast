import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { loginSchema, type LoginInput } from '@supplycast/shared';
import { Field } from '../../components/Field';
import { AuthLayout, FormError, Submit } from '../../components/AuthLayout';
import { useAuth } from './AuthContext';

export function LoginPage() {
  const { user, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (user) return <Navigate to="/" replace />;
  const from = (location.state as { from?: string } | null)?.from ?? '/';

  return (
    <AuthLayout title="Log in">
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (values) => {
          setError(null);
          try {
            await login(values);
            navigate(from, { replace: true });
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          registration={register('email')}
          error={errors.email?.message}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          registration={register('password')}
          error={errors.password?.message}
        />
        <Submit busy={isSubmitting}>Log in</Submit>
      </form>
      <p className="mt-4 text-sm text-gray-600">
        New company?{' '}
        <Link to="/signup" className="text-blue-600 underline">
          Create an account
        </Link>
      </p>
    </AuthLayout>
  );
}
