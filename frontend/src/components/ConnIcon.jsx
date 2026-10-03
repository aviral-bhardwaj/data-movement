import React from 'react';

// Deterministic pastel tile for a connector — initial letters on a hashed hue.
const PALETTE = [
  '#0b5fff', '#7c3aed', '#0e9f6e', '#d97706', '#dc2626',
  '#0369a1', '#be185d', '#4f46e5', '#047857', '#a16207',
  '#1d4ed8', '#9d174d', '#065f46', '#7e22ce', '#b91c1c',
];

export function hashHue(name = '') {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(h) % PALETTE.length;
}

export function initials(name = '') {
  const words = name.replace(/[^a-zA-Z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
  return (words[0]?.[0] || '?').toUpperCase() + (words[1]?.[0] || '').toUpperCase();
}

export default function ConnIcon({ name = '', icon, size }) {
  // emoji icons are used by native connectors; catalog rows use letter tiles
  if (icon && /\p{Emoji}/u.test(icon) && icon.length <= 4) {
    return <span className={`conn-icon ${size || ''}`} style={{ background: 'var(--surface-2)', border: '1px solid var(--border)', fontSize: size === 'lg' ? 22 : size === 'sm' ? 13 : 17 }}>{icon}</span>;
  }
  const bg = PALETTE[hashHue(name)];
  return <span className={`conn-icon ${size || ''}`} style={{ background: bg }}>{initials(name)}</span>;
}
