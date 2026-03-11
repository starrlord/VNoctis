import { useMemo } from 'react';

/**
 * Generates a CSS box-shadow string with `n` randomly-placed white dots
 * spread over a wide × 2000 px area.
 *
 * The horizontal spread uses the wider of 4000 px or the current viewport
 * width so stars always cover ultra-wide / 4 K displays.  The vertical
 * spread stays at 2000 px because the `animStar` keyframe and the
 * `::after` pseudo-elements in index.css rely on that exact value.
 */
function generateBoxShadow(n) {
  const spreadX = Math.max(4000, typeof window !== 'undefined' ? window.innerWidth : 4000);
  const spreadY = 2000;
  const shadows = [];
  for (let i = 0; i < n; i++) {
    shadows.push(
      `${Math.floor(Math.random() * spreadX)}px ${Math.floor(Math.random() * spreadY)}px #FFF`
    );
  }
  return shadows.join(', ');
}

/**
 * Pure-CSS parallax star field with three layers (small / medium / big)
 * scrolling upward at different speeds.
 *
 * Requires the `.star-field`, `.stars-small`, `.stars-medium`, `.stars-big`
 * classes defined in index.css.
 *
 * @param {{ fixed?: boolean, darkOnly?: boolean }} props
 *   `fixed`    — use `position: fixed` so the field stays behind scrollable
 *               content (useful for full-page layouts like Library).
 *   `darkOnly` — only render in dark mode (hides in light mode).
 */
export default function StarBackground({ fixed = false, darkOnly = false }) {
  const [small, medium, big] = useMemo(
    () => [generateBoxShadow(700), generateBoxShadow(200), generateBoxShadow(100)],
    []
  );

  const cls = [
    'star-field',
    fixed && '!fixed',
    darkOnly && 'hidden dark:block',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={cls}>
      <div className="stars-small" style={{ boxShadow: small }} />
      <div className="stars-medium" style={{ boxShadow: medium }} />
      <div className="stars-big" style={{ boxShadow: big }} />
    </div>
  );
}
