import type { ButtonHTMLAttributes } from "react";

const VARIANTS = {
  primary: "bg-ink text-bg hover:opacity-85",
  secondary: "border border-line bg-surface text-ink hover:bg-bg",
  danger: "border border-line bg-surface text-bad hover:bg-bad-soft",
};

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: keyof typeof VARIANTS;
}

/** A real button with a 44px touch target on phones. Disabled buttons keep their size, so the layout does not move. */
export function Button({ variant = "secondary", className = "", type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={`inline-flex min-h-11 items-center justify-center rounded-md px-4 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-45 sm:min-h-9 ${VARIANTS[variant]} ${className}`}
      {...rest}
    />
  );
}
