import { useState } from 'react';

/**
 * A listing photo, hot-linked from the source site. Falls back to a labelled
 * placeholder when there is no photo or it fails to load.
 */
export function Photo({
  src,
  alt,
  className = '',
  empty = 'No photo',
}: {
  src: string | null | undefined;
  alt: string;
  className?: string;
  empty?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return <div className={`photo photo--empty ${className}`}>{empty}</div>;
  }
  return (
    <img
      className={`photo ${className}`}
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
    />
  );
}
