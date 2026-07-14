import { redirect } from "next/navigation";
import { auth } from "@/auth";
import AppHeader from "@/components/AppHeader";
import McpSetupView from "@/components/McpSetupView";

export default async function McpSetupPage() {
  const session = await auth();
  if (!session?.user) redirect("/signin");

  return (
    <main className="min-h-screen bg-neutral-950 text-white">
      <AppHeader
        email={session.user.email}
        active="/mcp-setup"
        subtitle="Use your agents from Cursor and other MCP clients"
      />
      <div className="mx-auto max-w-4xl px-6 py-8">
        <McpSetupView />
      </div>
    </main>
  );
}
