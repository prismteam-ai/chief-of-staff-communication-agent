import { describe, expect, it } from "vitest";
import { detectIntent, extractTaskName, matchProject } from "@/lib/agent-runtime/skills";

describe("detectIntent", () => {
  it("detects status questions, singular and plural", () => {
    expect(detectIntent("What's the status of all projects?")).toBe("status");
    expect(detectIntent("Give me updates for all projects please")).toBe("status");
    expect(detectIntent("any news on the migration?")).toBe("status");
    expect(detectIntent("how is the website redesign going?")).toBe("status");
  });

  it("detects task creation requests", () => {
    expect(detectIntent("Please add a task for invoice reconciliation")).toBe("create");
    expect(detectIntent("don't forget to update the runbook")).toBe("create");
  });

  it("create wins over status when both appear", () => {
    expect(detectIntent("add a task to track the status report")).toBe("create");
  });

  it("returns null for plain conversation", () => {
    expect(detectIntent("Thanks, see you tomorrow at the office")).toBeNull();
  });
});

describe("extractTaskName", () => {
  it("prefers an explicitly quoted title and drops instruction chatter and reply chains", () => {
    const text =
      'In that project and call it "Build Email Automation Flows" and add some details about using azure functions and the basic subscription On Tue, Jul 14, 2026 at 1:38 AM Joaquin Rodriguez <JoaquinRodriguez@flowintelli.com> wrote: hi';
    expect(extractTaskName(text)).toBe("Build Email Automation Flows");
  });

  it("uses a quoted string after the create verb", () => {
    expect(extractTaskName('Please create "Quarterly budget review" for me')).toBe(
      "Quarterly budget review"
    );
  });

  it("extracts free text after the verb and trims follow-up clauses", () => {
    expect(
      extractTaskName("Can you add a task to reconcile vendor invoices and add some details later?")
    ).toBe("Reconcile vendor invoices");
  });

  it("never leaks a quoted reply chain into the title", () => {
    const name = extractTaskName(
      "please add follow up with legal On Mon, Jul 13, 2026 at 9:00 AM Someone wrote: previous thread"
    );
    expect(name).toBe("Follow up with legal");
  });

  it("returns null when nothing usable is present", () => {
    expect(extractTaskName("add it")).toBeNull();
  });
});

describe("matchProject", () => {
  const projects = [
    { gid: "1", name: "Website Redesign" },
    { gid: "2", name: "Automation requests queue" },
  ];

  it("matches an exact project name mention", () => {
    expect(matchProject("How is Website Redesign going?", projects)?.gid).toBe("1");
  });

  it("matches on significant word overlap", () => {
    expect(matchProject("status of the automation requests work", projects)?.gid).toBe("2");
  });

  it("returns null when nothing matches", () => {
    expect(matchProject("completely unrelated text", projects)).toBeNull();
  });
});
