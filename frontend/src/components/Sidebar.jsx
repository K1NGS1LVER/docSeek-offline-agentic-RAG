import React from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Network, NotebookPen, Home, Share2 } from 'lucide-react';

export default function Sidebar() {
  const location = useLocation();

  const navItems = [
    { label: 'Home', path: '/', icon: Home },
    { label: 'Notebooks', path: '/app', icon: NotebookPen },
    { label: 'Knowledge Graph', path: '/graph', icon: Network },
  ];

  return (
    <aside className="w-16 flex-shrink-0 bg-slate-900 border-r border-slate-800 flex flex-col items-center py-4 space-y-4">
      <Link to="/" className="font-serif font-bold text-cyan-400 text-lg mb-4" title="docSeek">
        <Share2 className="w-6 h-6 text-cyan-400" />
      </Link>
      <nav className="flex flex-col gap-3">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = location.pathname === item.path || (item.path !== '/' && location.pathname.startsWith(item.path));
          return (
            <Link
              key={item.path}
              to={item.path}
              title={item.label}
              className={`p-2.5 rounded-xl transition-colors ${
                isActive
                  ? 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/40'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800'
              }`}
            >
              <Icon className="w-5 h-5" />
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
