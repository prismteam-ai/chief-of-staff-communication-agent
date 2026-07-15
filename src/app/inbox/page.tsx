import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import InboxView from "@/components/InboxView";

export default async function InboxPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="flex h-screen flex-col bg-neutral-950 text-white">
      <AppHeader email={session.user.email} active="/inbox" subtitle="Unified inbox" />
      <div className="mx-auto w-full max-w-7xl flex-1 overflow-hidden px-6 py-6">
        <InboxView />
      </div>
    </main>
  );
}
