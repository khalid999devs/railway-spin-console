import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-accent text-on-accent hover:opacity-90",
  secondary: "border border-line bg-surface text-ink hover:bg-bg",
  danger: "border border-line bg-surface text-bad hover:bg-bad-soft",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

/** A real button with a 44px touch target. Disabled buttons keep their size, so the layout does not move. */
export function Button({ variant = "secondary", className = "", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 items-center justify-center rounded-lg px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
