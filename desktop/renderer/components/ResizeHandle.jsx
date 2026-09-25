// Adapted from nanobot SidebarResizeHandle.tsx (MIT; see upstream/nanobot-LICENSE).
import React, { useRef } from 'react';

export function ResizeHandle({ value, min, max, onChange, label, controls, ratio = false }) {
  const drag = useRef(null);
  const clamp = next => Math.min(max, Math.max(min, next));
  const move = event => {
    if (!drag.current) return;
    onChange(clamp(drag.current.value + (event.clientX - drag.current.x) / drag.current.scale));
  };
  return <div className="resize-handle" role="separator" tabIndex={0}
    aria-label={label} aria-orientation="vertical" aria-controls={controls}
    aria-valuemin={min} aria-valuemax={max} aria-valuenow={Math.round(value * 100) / 100}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { x: event.clientX, value, scale: ratio ? event.currentTarget.parentElement.clientWidth / 100 : 1 };
    }} onPointerMove={move}
    onPointerUp={event => { move(event); drag.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }}
    onPointerCancel={() => { drag.current = null; }} onLostPointerCapture={() => { drag.current = null; }}
    onDoubleClick={event => { event.preventDefault(); window.getSelection()?.removeAllRanges(); onChange(ratio ? 50 : 260); }}
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      onChange(event.key === 'Home' ? min : event.key === 'End' ? max : clamp(value + (event.key === 'ArrowLeft' ? -1 : 1) * (ratio ? 5 : 24)));
    }} />;
}
