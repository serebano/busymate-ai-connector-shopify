import { describe, expect, it } from "vitest";
import { plainMessage } from "../app/lib/plainMessage";

describe("admin transcript text", () => {
  it("drops emphasis and keeps link targets", () => {
    expect(plainMessage("- **The Compare at Price Snowboard**: now 785.95 USD.\nView it: [The Compare at Price Snowboard](/products/the-compare-at-price-snowboard)"))
      .toBe("• The Compare at Price Snowboard: now 785.95 USD.\nView it: The Compare at Price Snowboard (/products/the-compare-at-price-snowboard)");
  });
  it("leaves ordinary text, prices, numbered lists and lone symbols alone", () => {
    const text = "1. The Collection Snowboard: Hydrogen: 600.00 USD\n2 * 3 = 6, a_b_c and 5*";
    expect(plainMessage(text)).toBe(text);
  });
  it("a bare autolink shows once", () => {
    expect(plainMessage("[https://x.test/a](https://x.test/a)")).toBe("https://x.test/a");
  });
  it("headings and inline code lose their markers", () => {
    expect(plainMessage("## Shipping\nUse `#1002`")).toBe("Shipping\nUse #1002");
  });
});
