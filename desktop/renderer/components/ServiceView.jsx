import React, { useLayoutEffect, useRef } from 'react';

// One owner per DOM subtree. Existing citation, image editor, research and
// recommendation widgets retain their listeners and service state. No cloning,
// HTML mirroring, second transcript, or duplicate persistence writer.
export function ServiceView({ node, className = '' }) {
  const host = useRef(null);
  useLayoutEffect(() => {
    if (!node) return;
    host.current.append(node);
    return () => node.remove();
  }, [node]);
  return <div ref={host} className={`service-view ${className}`} />;
}
