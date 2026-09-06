import { Link, useLocation } from 'wouter';

const LINKS: Array<{ href: string; label: string }> = [
  { href: '/', label: 'Dashboard' },
  { href: '/capabilities', label: 'Capabilities' },
];

/** Top navigation shared by the post-onboarding pages. */
export function Nav() {
  const [location] = useLocation();
  return (
    <nav className="flex items-center gap-1 -mb-2 text-sm">
      {LINKS.map((l) => {
        const active = location === l.href;
        return (
          <Link
            key={l.href}
            href={l.href}
            className={[
              'px-3 py-1.5 rounded-md transition-colors',
              active
                ? 'bg-zinc-800 text-zinc-100'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900',
            ].join(' ')}
          >
            {l.label}
          </Link>
        );
      })}
    </nav>
  );
}
