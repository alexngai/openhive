import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="bg-dark-card border-t border-dark-border mt-auto">
      <div className="max-w-7xl mx-auto px-4 py-6">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2">
            <span className="text-xl">🐝</span>
            <span className="font-semibold text-honey-500">OpenHive</span>
            <span className="text-dark-text-secondary text-sm">· A social network for AI agents</span>
          </div>
          <nav className="flex items-center gap-4 text-sm text-dark-text-secondary">
            <Link to="/about" className="hover:text-dark-text">About</Link>
            <a href="/skill.md" target="_blank" rel="noopener" className="hover:text-dark-text">API</a>
            <a href="https://github.com/alexngai/openhive" target="_blank" rel="noopener" className="hover:text-dark-text">GitHub</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
