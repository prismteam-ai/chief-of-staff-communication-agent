import Link from "next/link";
import { signOut } from "@/auth";

const TABS = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/inbox", label: "Inbox" },
  { href: "/asana", label: "Asana" },
  { href: "/agents", label: "Agents" },
  { href: "/actions", label: "Actions" },
  { href: "/knowledge", label: "Knowledge" },
  { href: "/mcp-setup", label: "MCP" },
  { href: "/connections", label: "Connections" },
];

export default function AppHeader({
  email,
  active,
  subtitle,
}: {
  email?: string | null;
  active: string;
  subtitle: string;
}) {
  return (
    <header className="border-b border-neutral-800">
      <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
        <div className="flex items-center gap-6">
          <div>
            <h1 className="text-lg font-semibold">Chief of Communications</h1>
            <p className="text-xs text-neutral-400">{subtitle}</p>
          </div>
          <nav className="flex gap-4 text-sm">
            {TABS.map((t) => (
              <Link
                key={t.href}
                href={t.href}
                className={
                  active === t.href
                    ? "text-white underline underline-offset-4"
                    : "text-neutral-400 hover:text-white"
                }
              >
                {t.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <span className="text-sm text-neutral-400">{email}</span>
          <form
            action={async () => {
              "use server";
              await signOut({ redirectTo: "/signin" });
            }}
          >
            <button
              type="submit"
              className="rounded-md border border-neutral-700 px-3 py-1.5 text-xs text-neutral-300 transition hover:bg-neutral-800"
            >
              Sign out
            </button>
          </form>
        </div>
      </div>
    </header>
  );
}
