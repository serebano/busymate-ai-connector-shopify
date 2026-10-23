import { describe, expect, it } from "vitest";
import { brandedAssistantName, effectiveAssistantName, isPlatformPersonaName } from "../app/lib/assistantName";

// #2618 follow-up — Settings showed "your mate" while the storefront greeted shoppers as
// "Tony Stark AI": the platform treats its own persona phrase as unset on a store.
describe("assistant name the merchant sees == the name shoppers see", () => {
  it("RED→GREEN: 'your mate' on a store resolves to '<Store> AI' (the platform rule)", () => {
    expect(effectiveAssistantName("your mate", "Tony Stark")).toBe("Tony Stark AI");
    expect(effectiveAssistantName("Your Mate", "Tony Stark")).toBe("Tony Stark AI");
    expect(effectiveAssistantName("bro", "Acme")).toBe("Acme AI");
    expect(effectiveAssistantName("", "Acme")).toBe("Acme AI");
    expect(effectiveAssistantName(null, "Acme")).toBe("Acme AI");
  });
  it("a merchant's own name is kept verbatim", () => {
    expect(effectiveAssistantName("Tony", "Tony Stark")).toBe("Tony");
    expect(isPlatformPersonaName("Tony")).toBe(false);
  });
  it("never doubles 'AI'", () => {
    expect(brandedAssistantName("Nordic AI")).toBe("Nordic AI");
    expect(brandedAssistantName("Nordai")).toBe("Nordai AI");
  });
});

describe("Settings route wiring", () => {
  it("loads the effective name and normalizes the platform persona on save", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("app/routes/app.settings.tsx", "utf8");
    expect(src).toContain("effectiveAssistantName(");
    expect(src).toContain("isPlatformPersonaName(typedAssistantName)");
    expect(src).not.toContain("(default: your mate)");
  });
});
