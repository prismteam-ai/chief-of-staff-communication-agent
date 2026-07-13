import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import ConnectionsDashboard from "@/components/ConnectionsDashboard";

export default async function ConnectionsPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader
        email={session.user.email}
        active="/connections"
        subtitle="Channel connections"
      />
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
