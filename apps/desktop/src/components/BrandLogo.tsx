import React from 'react';
import { CORESENSE_TAGLINE } from '@coresense/shared';

export const BrandLogo: React.FC<{ compact?: boolean; subtitle?: boolean; size?: 'sm' | 'md' }> = ({
  compact = false,
  subtitle = false,
  size = 'md',
}) => {
  const boxClass = size === 'sm' ? 'h-8 w-8 rounded-lg' : 'h-10 w-10 rounded-[10px]';
  const svgClass = size === 'sm' ? 'h-5 w-5' : 'h-6 w-6';

  return (
    <div className="group flex items-center gap-2.5 select-none">
      <div
        className={`relative flex ${boxClass} shrink-0 items-center justify-center bg-[#000000] border border-[#262b31]`}
      >
        <svg viewBox="0 0 128 128" className={svgClass} fill="none" aria-hidden="true">
          <path d="M18 18 H34 M18 18 V34" stroke="#4a525c" strokeWidth="4" strokeLinecap="square" />
          <path d="M110 110 H94 M110 110 V94" stroke="#4a525c" strokeWidth="4" strokeLinecap="square" />
          <path
            d="M16 68 H42 L53 34 L67 96 L78 52 L87 68 H112"
            stroke="#7BA7F7"
            strokeWidth="8.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="cs-animate-logo-pulse"
          />
          <circle cx="112" cy="68" r="5.5" fill="#5EC6A8" />
        </svg>
      </div>
      {!compact && (
        <div className="leading-tight">
          <div
            className={`cs-heading font-bold tracking-tight text-[var(--cs-ink)] ${
              size === 'sm' ? 'text-[15px]' : 'text-lg'
            }`}
          >
            CoreSense
          </div>
          {subtitle && (
            <p className="text-xs text-[var(--cs-ink-muted)] mt-0.5">{CORESENSE_TAGLINE}</p>
          )}
        </div>
      )}
    </div>
  );
};
