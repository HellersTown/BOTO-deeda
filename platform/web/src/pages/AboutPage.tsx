import { Link } from 'react-router-dom';
import { JarMark } from '../components/Logo';
import { useDocumentTitle } from '../hooks/useDocumentTitle';

export function AboutPage() {
  useDocumentTitle('About');
  return (
    <div className="page page--narrow">
      <header className="page-head">
        <h1 className="page-title">About Skeuos</h1>
      </header>
      <div className="about">
        <JarMark size={64} />
        <p>
          Skeuos (σκεῦος) is the Greek word the New Testament uses for a vessel, and for household goods, tools and gear of
          every kind. A great house holds vessels of gold and silver, wood and clay, each useful for its work (2 Timothy
          2:20–21). Auctions are full of them. Skeuos helps you find the right one.
        </p>
        <p>
          One word covers everything from tiny screwdrivers to sledgehammers, so context decides which item is meant. That is
          why every search shows how your words were read, and lets you correct it.
        </p>
        <p>
          Skeuos gathers federal, state, county, school, private and estate sales, ranks them by distance from your ZIP, and
          keeps looking for the things you describe. It never bids for you: it opens the lot on the auction’s own site.
        </p>
        <p>
          <Link to="/">Start a search</Link>
        </p>
      </div>
    </div>
  );
}
