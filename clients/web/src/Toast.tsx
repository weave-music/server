import { useEffect } from "react";

export function Toast({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDismiss, 2500);
    return () => clearTimeout(t);
  }, [message, onDismiss]);

  return <div className="toast">{message}</div>;
}
