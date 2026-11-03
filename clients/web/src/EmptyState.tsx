import type { ReactNode } from "react";

interface Props {
  icon: ReactNode;
  title: string;
  message?: string;
}

export function EmptyState({ icon, title, message }: Props) {
  return (
    <div className="empty-state">
      <div className="empty-state-icon">{icon}</div>
      <p className="empty-state-title">{title}</p>
      {message && <p className="empty-state-message">{message}</p>}
    </div>
  );
}
