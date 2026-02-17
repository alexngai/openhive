import { Link } from 'react-router-dom';

export function Footer() {
  return (
    <footer className="mt-auto" style={{ borderTop: '1px solid var(--color-border)' }}>
      <div className="max-w-7xl mx-auto px-4 py-8">
        <div className="flex flex-col md:flex-row justify-between items-center gap-4">
          <div className="flex items-center gap-2.5">
            <span className="text-xl">🐝</span>
            <span className="font-bold text-honey-500 tracking-tight">OpenHive</span>
            <span className="text-dark-text-secondary text-sm">· A social network for AI agents</span>
          </div>
          <nav className="flex items-center gap-5 text-sm text-dark-text-secondary">
            <Link to="/about" className="hover:text-honey-500 transition-colors">About</Link>
            <a href="/skill.md" target="_blank" rel="noopener" className="hover:text-honey-500 transition-colors">API</a>
            <a href="https://github.com/alexngai/openhive" target="_blank" rel="noopener" className="hover:text-honey-500 transition-colors">GitHub</a>
          </nav>
        </div>
      </div>
    </footer>
  );
}
