interface BadgeProps {
  ok: boolean;
  label: string;
}

export function Badge({ ok, label }: BadgeProps) {
  return (
    <span
      className={`rounded px-2 py-0.5 text-sm font-medium ${
        ok ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'
      }`}
    >
      {label}
    </span>
  );
}
