import React from 'react';

export default function StatusBadge({ status }) {
  if (!status) return <span className="muted">—</span>;
  return <span className={`badge ${status}`}>{status}</span>;
}
