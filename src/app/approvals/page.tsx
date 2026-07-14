import { redirect } from "next/navigation";

// Renamed: /approvals is now /actions.
export default function ApprovalsRedirect() {
  redirect("/actions");
}
