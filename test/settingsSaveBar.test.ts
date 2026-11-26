// @vitest-environment happy-dom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { AppProvider } from "@shopify/polaris";
import translations from "@shopify/polaris/locales/en.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Save-bar behaviour of Assistant settings, in a DOM (Built for Shopify 4.1.5 / 4.2.4;
 * reviewer checklist A5, A6). App Bridge itself is the admin's: the test stands in for
 * `<SaveBar>` with an element that records `open` and exposes the two buttons the real
 * `ui-save-bar` reads (variant="primary" = Save, the other = Discard).
 */
const h = vi.hoisted(() => ({
  loader: { assistantName: "Peak Helper", displayName: "North Peak", provisioned: true, loadError: false },
  fetcher: { state: "idle" as string, data: undefined as unknown, submit: vi.fn() },
  blocker: { state: "unblocked" as string, proceed: vi.fn(), reset: vi.fn() },
  blockerArg: [] as boolean[],
  toast: vi.fn(),
  leaveConfirmation: vi.fn(async () => {}),
  hide: vi.fn(async () => {}),
}));
vi.mock("react-router", async () => ({
  ...(await vi.importActual("react-router")),
  useLoaderData: () => h.loader,
  useFetcher: () => h.fetcher,
  useBlocker: (when: boolean) => (h.blockerArg.push(when), h.blocker),
}));
vi.mock("@shopify/app-bridge-react", () => ({
  TitleBar: () => null,
  SaveBar: ({ id, open, children }: { id: string; open?: boolean; children?: ReactNode }) => createElement("ui-save-bar", { id, "data-open": String(Boolean(open)) }, children),
  useAppBridge: () => ({ toast: { show: h.toast }, saveBar: { leaveConfirmation: h.leaveConfirmation, hide: h.hide } }),
}));
vi.mock("../app/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("../app/db.server", () => ({ default: {} }));
vi.mock("../app/bmai.server", () => ({ setTenantBranding: vi.fn() }));
vi.mock("../app/lib/ingest", () => ({ queueRetrainForMerchant: vi.fn() }));
vi.mock("../app/lib/tenantRead.server", () => ({ readTenantBranding: vi.fn() }));
import SettingsPage, { SETTINGS_SAVE_BAR_ID } from "../app/routes/app.settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
const render = () => act(() => root.render(createElement(AppProvider, { i18n: translations, children: createElement(SettingsPage) })));
const field = (name: string) => host.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
const bar = () => host.querySelector("ui-save-bar")!;
const barOpen = () => bar().getAttribute("data-open") === "true";
const saveButton = () => bar().querySelector<HTMLButtonElement>('button[variant="primary"]')!;
const discardButton = () => bar().querySelector<HTMLButtonElement>("button:not([variant])")!;
const type = (name: string, value: string) =>
  act(() => {
    const input = field(name);
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const click = (el: HTMLElement) => act(() => el.click());
/** The action finished: the fetcher goes back to idle with `data`. */
const finish = async (data: unknown) => {
  h.fetcher = { ...h.fetcher, state: "idle", data };
  await render();
};
const fieldError = (name: string) => host.querySelector(`#${CSS.escape(field(name).id)}Error`)?.textContent ?? null;

beforeEach(async () => {
  h.loader = { assistantName: "Peak Helper", displayName: "North Peak", provisioned: true, loadError: false };
  h.fetcher = { state: "idle", data: undefined, submit: vi.fn() };
  h.blocker = { state: "unblocked", proceed: vi.fn(), reset: vi.fn() };
  h.blockerArg.length = 0;
  h.toast.mockClear();
  h.leaveConfirmation.mockClear();
  h.hide.mockClear();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await render();
});
afterEach(async () => {
  await act(() => root.unmount());
  host.remove();
});

describe("Assistant settings: contextual save bar", () => {
  it("is closed on load, shows no error, and the page has no Save button of its own", () => {
    expect(bar().id).toBe(SETTINGS_SAVE_BAR_ID);
    expect(barOpen()).toBe(false);
    expect(host.querySelector('[id$="Error"]')).toBeNull();
    const pageButtons = [...host.querySelectorAll("button")].filter((b) => !bar().contains(b) && b.textContent?.trim() === "Save");
    expect(pageButtons).toHaveLength(0);
  });

  it("opens on the first edit and closes when the value is typed back", async () => {
    await type("assistantName", "Peak Helper 2");
    expect(barOpen()).toBe(true);
    await type("assistantName", "Peak Helper");
    expect(barOpen()).toBe(false);
  });

  it("Discard puts the saved values back and closes the bar without saving", async () => {
    await type("assistantName", "Riley");
    await type("displayName", "Acme");
    await click(discardButton());
    expect(field("assistantName").value).toBe("Peak Helper");
    expect(field("displayName").value).toBe("North Peak");
    expect(barOpen()).toBe(false);
    expect(h.fetcher.submit).not.toHaveBeenCalled();
  });

  it("Save posts the edited values once and shows loading while it runs", async () => {
    await type("assistantName", "Riley");
    await click(saveButton());
    expect(h.fetcher.submit).toHaveBeenCalledTimes(1);
    expect(h.fetcher.submit).toHaveBeenCalledWith({ assistantName: "Riley", displayName: "North Peak" }, { method: "post" });
    h.fetcher = { ...h.fetcher, state: "submitting" };
    await render();
    expect(saveButton().hasAttribute("loading")).toBe(true);
    expect(saveButton().disabled).toBe(true);
    expect(discardButton().disabled).toBe(true);
    await click(saveButton());
    expect(h.fetcher.submit).toHaveBeenCalledTimes(1);
  });

  it("a successful save closes the bar, keeps the saved values and confirms with a toast", async () => {
    await type("assistantName", "your mate");
    await click(saveButton());
    await finish({ ok: true, error: null, fieldErrors: null, assistantName: "North Peak AI", displayName: "North Peak", notice: null });
    expect(barOpen()).toBe(false);
    expect(field("assistantName").value).toBe("North Peak AI");
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.toast.mock.calls[0][1]).not.toMatchObject({ isError: true });
    // The same result must not be applied twice (a re-render would wipe a newer edit).
    await type("assistantName", "Newer");
    await render();
    expect(field("assistantName").value).toBe("Newer");
    expect(barOpen()).toBe(true);
  });

  it("a failed save keeps the edit and the bar, and explains in a banner that stays (no error toast)", async () => {
    await type("assistantName", "Riley");
    await click(saveButton());
    await finish({ ok: false, error: "We couldn't save your assistant settings. Nothing was changed.", fieldErrors: null });
    expect(barOpen()).toBe(true);
    expect(field("assistantName").value).toBe("Riley");
    expect(host.textContent).toContain("Your changes weren't saved");
    expect(host.textContent).toContain("Nothing was changed.");
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("a dropped connection (transport failure) is handled the same way", async () => {
    await type("assistantName", "Riley");
    await click(saveButton());
    await finish({ ok: false, error: "The connection dropped. Please try again.", transport: true });
    expect(barOpen()).toBe(true);
    expect(host.textContent).toContain("The connection dropped.");
  });

  it("does nothing while the assistant is not set up: fields are disabled and the bar never opens", async () => {
    h.loader = { ...h.loader, provisioned: false };
    await render();
    expect(field("assistantName").disabled).toBe(true);
    expect(field("displayName").disabled).toBe(true);
    expect(barOpen()).toBe(false);
  });
});

describe("Assistant settings: inline field errors", () => {
  it("an empty name is refused in the browser with the message next to that field only", async () => {
    await type("assistantName", "");
    await click(saveButton());
    expect(h.fetcher.submit).not.toHaveBeenCalled();
    expect(fieldError("assistantName")).toContain("Enter a name for your assistant.");
    expect(fieldError("displayName")).toBeNull();
    expect(field("assistantName").getAttribute("aria-invalid")).toBe("true");
    expect(barOpen()).toBe(true);
    expect(h.toast).not.toHaveBeenCalled();
  });

  it("the message leaves when the merchant edits that field", async () => {
    await type("assistantName", "");
    await click(saveButton());
    await type("assistantName", "R");
    expect(fieldError("assistantName")).toBeNull();
  });

  it("a field error from the SERVER is shown by its field, not in a banner", async () => {
    await type("displayName", "Acme");
    await click(saveButton());
    await finish({ ok: false, error: "Both names are required.", fieldErrors: { displayName: "Enter your store's display name." } });
    expect(fieldError("displayName")).toContain("Enter your store's display name.");
    expect(host.textContent).not.toContain("Your changes weren't saved");
  });
});

describe("Assistant settings: leaving with unsaved changes", () => {
  it("blocks the app's own navigation only while there are unsaved changes", async () => {
    expect(h.blockerArg.at(-1)).toBe(false);
    await type("assistantName", "Riley");
    expect(h.blockerArg.at(-1)).toBe(true);
    await click(discardButton());
    expect(h.blockerArg.at(-1)).toBe(false);
  });

  it("asks through Shopify's leave prompt, then hides the bar and continues", async () => {
    await type("assistantName", "Riley");
    h.blocker = { ...h.blocker, state: "blocked" };
    await render();
    await act(async () => {});
    expect(h.leaveConfirmation).toHaveBeenCalledTimes(1);
    expect(h.hide).toHaveBeenCalledWith(SETTINGS_SAVE_BAR_ID);
    expect(h.blocker.proceed).toHaveBeenCalledTimes(1);
  });

  it("stays on the page when the prompt is refused", async () => {
    h.leaveConfirmation.mockRejectedValueOnce(new Error("cancelled"));
    await type("assistantName", "Riley");
    h.blocker = { ...h.blocker, state: "blocked" };
    await render();
    await act(async () => {});
    expect(h.blocker.proceed).not.toHaveBeenCalled();
    expect(h.blocker.reset).toHaveBeenCalledTimes(1);
    expect(field("assistantName").value).toBe("Riley");
  });
});
