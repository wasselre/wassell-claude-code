interface BadgeProps {
  label: string;
  color?: string;
  className?: string;
}

export default function Badge({ label, color = '#B8734F', className = '' }: BadgeProps) {
  return (
    <span
      className={`badge ${className}`}
      style={{
        backgroundColor: `${color}20`,
        color: color,
      }}
    >
      {label}
    </span>
  );
}
