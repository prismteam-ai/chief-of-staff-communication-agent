import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth, signOut } from "@/auth";
import ConnectionsDashboard from "@/components/ConnectionsDashboard";

export default async function ConnectionsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <header className="border-b border-neutral-800">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
          <div>
            <h1 className="text-lg font-semibold">Chief of Communications</h1>
            <p className="text-xs text-neutral-400">Channel connections</p>
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

      <div className="mx-auto max-w-5xl px-6 py-8">
        <h2 className="text-xl font-semibold">Connect your channels</h2>
        <p className="mt-1 text-sm text-neutral-400">
          Grant access to the channels you want your AI chief of communications to
          manage. Tokens are encrypted at rest and can be revoked anytime.
        </p>
        <Suspense fallback={<p className="mt-8 text-sm text-neutral-500">Loading channels…</p>}>
          <ConnectionsDashboard />
        </Suspense>
      </div>
    </main>
  );
}
