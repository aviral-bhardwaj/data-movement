import React from 'react';

export function LogoMark({ size = 26 }) {
  return (
    <svg className="mark" width={size} height={size} viewBox="0 0 32 32" fill="none">
      <rect width="32" height="32" rx="7" fill="#0b5fff" />
      <path d="M9 12h14M9 20h14M15 8l-6 4 6 4M17 16l6 4-6 4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export default function Logo({ light = false }) {
  return (
    <span className="brand" style={{ color: light ? '#fff' : undefined }}>
      <LogoMark />
      DataMove
    </span>
  );
}
