import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function PasswordInput({ id, label, value, onChange, error, hint, required, disabled }: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
}) {
  const feedback = error || hint;
  return <div className="field">
    <Label htmlFor={id}>{label}</Label>
    <Input id={id} type="password" autoComplete="new-password" value={value} required={required} disabled={disabled}
      onChange={event => onChange(event.target.value)} aria-invalid={Boolean(error)}
      aria-describedby={feedback ? `${id}-feedback` : undefined} />
    <p id={`${id}-feedback`} aria-live="polite" hidden={!feedback} className={error ? "text-sm text-destructive" : "hint"}>{feedback}</p>
  </div>;
}
