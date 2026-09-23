import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/**
 * Render children into `document.body` (outside overflow/stacking contexts).
 * Renders nothing during SSR-like environments without a document.
 */
export function Portal({ children }: { children: ReactNode }) {
  const [host, setHost] = useState<HTMLElement | null>(() =>
    typeof document !== "undefined" ? document.body : null
  );
  useEffect(() => {
    if (!host && typeof document !== "undefined") setHost(document.body);
  }, [host]);
  return host ? createPortal(children, host) : null;
}
