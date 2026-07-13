import { redirect } from "next/navigation";
import Link from "next/link";
import { auth, signOut } from "@/auth";
import InboxView from "@/components/InboxView";

export default async function InboxPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-white">
      <header className="border-b border-neutral-800">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-6 py-4">
          <div className="flex items-center gap-6">
            <div>
              <h1 className="text-lg font-semibold">Chief of Communications</h1>
              <p className="text-xs text-neutral-400">Unified inbox</p>
            </div>
            <nav className="flex gap-4 text-sm">
              <Link href="/inbox" className="text-white underline underline-offset-4">
                Inbox
              </Link>
              <Link href="/connections" className="text-neutral-400 hover:text-white">
                Connections
              </Link>
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <span className="text-sm text-neutral-400">{session.user.email}</span>
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

      <div className="mx-auto w-full max-w-7xl flex-1 overflow-hidden px-6 py-6">
        <InboxView />
      </div>
    </main>
  );
}
