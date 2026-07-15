import { describe, expect, it } from "vitest";
import { stripQuoted } from "@/lib/agent-runtime";

describe("stripQuoted", () => {
  it("removes a Gmail-style quoted chain on its own line", () => {
    const text = "Sounds good.\nOn Tue, Jul 14, 2026 at 1:38 AM Joaquin wrote:\n> earlier message";
    expect(stripQuoted(text)).toBe("Sounds good.");
  });

  it("removes a mid-line quoted chain (flattened bodies)", () => {
    const text =
      "Give me updates for all projects please On Tue, Jul 14, 2026 at 1:22 AM Joaquin Rodriguez <j@x.com> wrote: hello";
    expect(stripQuoted(text)).toBe("Give me updates for all projects please");
  });

  it("removes Outlook From:/Sent: separators", () => {
    const text = "New content here.\nFrom: Someone <s@x.com>\nSent: Monday\nOld thread body";
    expect(stripQuoted(text)).toBe("New content here.");
  });

  it("drops > quoted lines", () => {
    expect(stripQuoted("Reply line\n> quoted one\n> quoted two")).toBe("Reply line");
  });

  it("returns plain text unchanged", () => {
    expect(stripQuoted("Just a normal message")).toBe("Just a normal message");
  });
});
