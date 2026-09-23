/** The AETHER mark: an orbit around an apex. Inherits `currentColor`. */
export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4.2 12.4 8 3.6l3.8 8.8"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <ellipse cx="8" cy="9.6" rx="6.6" ry="2.5" stroke="currentColor" strokeOpacity="0.55" strokeWidth="1.2" />
    </svg>
  );
}
