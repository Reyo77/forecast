import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { signupSchema, type SignupInput } from '@supplycast/shared';
import { Field } from '../../components/Field';
import { AuthLayout, FormError, Submit } from '../../components/AuthLayout';
import { useAuth } from './AuthContext';

export function SignupPage() {
  const { user, signup } = useAuth();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({ resolver: zodResolver(signupSchema) });

  if (user) return <Navigate to="/" replace />;

  return (
    <AuthLayout title="Create your company account">
      <form
        className="space-y-4"
        onSubmit={handleSubmit(async (values) => {
          setError(null);
          try {
            await signup(values);
            navigate('/', { replace: true });
          } catch (e) {
            setError((e as Error).message);
          }
        })}
      >
        <FormError message={error} />
        <Field
          label="Company name"
          registration={register('companyName')}
          error={errors.companyName?.message}
        />
        <Field
          label="Your name"
          autoComplete="name"
          registration={register('name')}
          error={errors.name?.message}
        />
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
          autoComplete="new-password"
          registration={register('password')}
          error={errors.password?.message}
        />
        <p className="text-xs text-gray-500">At least 10 characters, with a letter and a number.</p>
        <Submit busy={isSubmitting}>Sign up</Submit>
      </form>
      <p className="mt-4 text-sm text-gray-600">
        Already have an account?{' '}
        <Link to="/login" className="text-blue-600 underline">
          Log in
        </Link>
      </p>
    </AuthLayout>
  );
}
