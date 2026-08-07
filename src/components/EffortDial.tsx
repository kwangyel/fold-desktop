import { EFFORT_LABELS } from '../lib/effort';
import type { EffortLevel } from '../lib/harnesses';
import './EffortDial.css';

type EffortDialProps = {
  options: EffortLevel[];
  value: EffortLevel;
  disabled?: boolean;
  onChange: (effort: EffortLevel) => void;
};

const RADIUS = 9;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function EffortDial({
  options,
  value,
  disabled,
  onChange,
}: EffortDialProps) {
  const currentIndex = options.indexOf(value);
  const fillRatio =
    options.length > 0
      ? (currentIndex === -1 ? 0 : currentIndex + 1) / options.length
      : 0;
  const dashOffset = CIRCUMFERENCE * (1 - fillRatio);
  const label = EFFORT_LABELS[value] ?? value;

  const handleClick = () => {
    if (disabled || options.length === 0) return;
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + 1) % options.length;
    onChange(options[nextIndex]);
  };

  return (
    <button
      type="button"
      className="effort-dial"
      onClick={handleClick}
      disabled={disabled}
      title={`Effort: ${options.map((e) => EFFORT_LABELS[e]).join(' → ')}`}
      aria-label={`Effort: ${label}. Click to cycle.`}
    >
      <svg
        className="effort-dial-ring"
        viewBox="0 0 24 24"
        width={24}
        height={24}
        aria-hidden="true"
      >
        <circle
          className="effort-dial-track"
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
        />
        <circle
          className="effort-dial-fill"
          cx="12"
          cy="12"
          r={RADIUS}
          fill="none"
          strokeWidth="2.5"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform="rotate(-90 12 12)"
        />
      </svg>
      <span className="effort-dial-label">{label}</span>
    </button>
  );
}
