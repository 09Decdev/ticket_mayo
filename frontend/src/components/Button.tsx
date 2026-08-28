import { ButtonHTMLAttributes, forwardRef } from 'react';

type Variant = 'primary' | 'secondary' | 'danger' | 'link';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  loading?: boolean;
}

const cls: Record<Variant, string> = {
  primary: 'btn',
  secondary: 'btn btn-secondary',
  danger: 'btn btn-danger',
  link: 'btn btn-link',
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'primary', loading, disabled, children, className, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      className={`${cls[variant]}${className ? ' ' + className : ''}`}
      disabled={disabled || loading}
      {...rest}
    >
      {loading && <span className="spinner" aria-hidden />}
      {children}
    </button>
  );
});
