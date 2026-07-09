"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

export default function TopBar({
  username,
  role,
}: {
  username: string;
  role: string;
}) {
  const router = useRouter();
  const pathname = usePathname();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.push("/login");
    router.refresh();
  }

  const tab = (href: string, label: string) => (
    <Link
      href={href}
      className={`px-3 py-1.5 rounded-lg text-sm font-medium ${
        pathname === href
          ? "bg-[var(--color-panel-2)] text-[var(--color-text)]"
          : "text-[var(--color-muted)] hover:text-[var(--color-text)]"
      }`}
    >
      {label}
    </Link>
  );

  return (
    <header className="flex items-center justify-between px-4 h-14 border-b border-[var(--color-border)] shrink-0">
      <div className="flex items-center gap-6">
        <div className="font-bold tracking-tight">
          Chief of Staff
        </div>
        <nav className="flex items-center gap-1">
          {tab("/", "Workspace")}
          {tab("/style", "Style")}
          {tab("/connections", "Connections")}
        </nav>
      </div>
      <div className="flex items-center gap-3">
        <span className="chip">
          {username}
          <span
            className="ml-1"
            style={{
              color:
                role === "owner" ? "var(--color-good)" : "var(--color-muted)",
            }}
          >
            {role}
          </span>
        </span>
        <button onClick={logout} className="btn btn-ghost">
          Sign out
        </button>
      </div>
    </header>
  );
}
