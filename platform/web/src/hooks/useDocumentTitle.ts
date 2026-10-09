import { useEffect } from 'react';

/** "Hunts · Skeuos". */
export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    document.title = title ? `${title} · Skeuos` : 'Skeuos';
  }, [title]);
}
