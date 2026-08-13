/** Linear mark — chevron used as the Apps / issue-picker icon. */
export default function LinearLogo({
  size = 16,
  className,
}: {
  size?: number;
  className?: string;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      className={className}
      aria-hidden
    >
      <path d="M2.83 2.83a4 4 0 0 1 5.66 0L21.17 15.5a4 4 0 0 1-5.66 5.66L2.83 8.49a4 4 0 0 1 0-5.66Z" />
    </svg>
  );
}
