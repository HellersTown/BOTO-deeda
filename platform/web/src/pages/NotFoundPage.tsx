import { Link } from 'react-router-dom';
import { EmptyState } from '../components/States';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function NotFoundPage() {
  useDocumentTitle('Not found');
  return (
    <div className="page">
      <EmptyState
        title="There is nothing at this address"
        action={
          <Link to="/" className="btn btn--primary">
            Go to search
          </Link>
        }
      >
        <p>The link may be old, or mistyped.</p>
      </EmptyState>
    </div>
  );
}
