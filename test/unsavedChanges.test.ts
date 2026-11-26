import { describe, expect, it } from "vitest";
import { formReducer, initialFormState, isDirty, type FormState } from "../app/lib/unsavedChanges";
import { ASSISTANT_NAME_MAX, PRODUCT_NAME_MAX, brandingFieldErrors, saveBrandingAndRepublish } from "../app/lib/brandingSave";

// Built for Shopify 4.1.5 (contextual save bar) + 4.2.4 (errors by the field, never
// before the merchant acts, never fading): the rules the Assistant settings form follows.

type Names = { assistantName: string; displayName: string };
const saved: Names = { assistantName: "Peak Helper", displayName: "North Peak" };
const start = (): FormState<Names> => initialFormState(saved);

describe("when the save bar shows", () => {
  it("is hidden on a form nobody touched, with no error anywhere", () => {
    const s = start();
    expect(isDirty(s.values, s.saved)).toBe(false);
    expect(s.errors).toEqual({});
    expect(s.formError).toBeNull();
  });

  it("shows after an edit and hides again when the value is typed back", () => {
    let s = formReducer(start(), { type: "edit", field: "assistantName", value: "Peak Helper 2" });
    expect(isDirty(s.values, s.saved)).toBe(true);
    s = formReducer(s, { type: "edit", field: "assistantName", value: "Peak Helper" });
    expect(isDirty(s.values, s.saved)).toBe(false);
  });

  it("counts a whitespace-only edit as a change (the merchant typed it)", () => {
    const s = formReducer(start(), { type: "edit", field: "displayName", value: "North Peak " });
    expect(isDirty(s.values, s.saved)).toBe(true);
  });

  it("Discard restores the saved values and clears every error", () => {
    let s = formReducer(start(), { type: "edit", field: "assistantName", value: "" });
    s = formReducer(s, { type: "invalid", errors: { assistantName: "Enter a name for your assistant." } });
    s = formReducer(s, { type: "discard" });
    expect(s.values).toEqual(saved);
    expect(s.errors).toEqual({});
    expect(isDirty(s.values, s.saved)).toBe(false);
  });

  it("a successful save makes the SERVER's values the saved ones (bar hides)", () => {
    let s = formReducer(start(), { type: "edit", field: "assistantName", value: "your mate" });
    s = formReducer(s, { type: "submit" });
    s = formReducer(s, { type: "saved", values: { assistantName: "North Peak AI", displayName: "North Peak" } });
    expect(s.values.assistantName).toBe("North Peak AI");
    expect(isDirty(s.values, s.saved)).toBe(false);
  });

  it("a FAILED save keeps the edit and the bar: nothing is lost and nothing looks saved", () => {
    let s = formReducer(start(), { type: "edit", field: "assistantName", value: "Riley" });
    s = formReducer(s, { type: "submit" });
    s = formReducer(s, { type: "failed", formError: "We couldn't save your assistant settings." });
    expect(s.values.assistantName).toBe("Riley");
    expect(s.saved).toEqual(saved);
    expect(isDirty(s.values, s.saved)).toBe(true);
    expect(s.formError).toMatch(/couldn't save/);
  });
});

describe("where an error shows", () => {
  it("a field failure is shown by the field only, not repeated in the banner", () => {
    const s = formReducer(start(), { type: "failed", errors: { displayName: "Enter your store's display name." }, formError: "Both names are required." });
    expect(s.errors.displayName).toBeTruthy();
    expect(s.formError).toBeNull();
  });

  it("editing a field clears its own error and leaves the other field's error", () => {
    let s = formReducer(start(), { type: "invalid", errors: { assistantName: "a", displayName: "b" } });
    s = formReducer(s, { type: "edit", field: "assistantName", value: "x" });
    expect(s.errors).toEqual({ displayName: "b" });
  });

  it("a new save attempt clears the previous banner", () => {
    let s = formReducer(start(), { type: "failed", formError: "nope" });
    s = formReducer(s, { type: "submit" });
    expect(s.formError).toBeNull();
  });
});

describe("branding field errors", () => {
  it("valid names have no errors", () => {
    expect(brandingFieldErrors({ assistantName: "Riley", productName: "Acme" })).toEqual({});
  });

  it("each empty field gets its own message that says what to do", () => {
    expect(brandingFieldErrors({ assistantName: "  ", productName: "" })).toEqual({
      assistantName: "Enter a name for your assistant.",
      displayName: "Enter your store's display name.",
    });
    expect(brandingFieldErrors({ assistantName: "", productName: "Acme" })).toEqual({ assistantName: "Enter a name for your assistant." });
  });

  it("a too-long name names the limit of that field", () => {
    expect(brandingFieldErrors({ assistantName: "a".repeat(ASSISTANT_NAME_MAX + 1), productName: "b".repeat(PRODUCT_NAME_MAX + 1) })).toEqual({
      assistantName: "Use 40 characters or fewer.",
      displayName: "Use 80 characters or fewer.",
    });
  });

  it("the SERVER returns the same field errors and writes nothing (it never trusts the browser)", async () => {
    let calls = 0;
    const deps = { setBranding: async () => (calls++, { ok: true }), republish: async () => (calls++, { ok: true }) };
    const out = await saveBrandingAndRepublish("acme.myshopify.com", "t_1", { assistantName: "", productName: "Acme" }, deps);
    expect(out.ok).toBe(false);
    expect(out.fieldErrors).toEqual({ assistantName: "Enter a name for your assistant." });
    expect(calls).toBe(0);
  });
});
