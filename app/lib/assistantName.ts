/**
 * The ONE default assistant name a newly provisioned merchant tenant is seeded
 * with, and the value the Settings form falls back to.
 *
 * It lives here — not in a route module — because BOTH the provisioning
 * lifecycle (`app/lib/provision.ts`, which seeds a brand-new tenant's branding)
 * and the embedded Settings route read it. Two copies drifted once already:
 * provisioning seeded the RETIRED sentinel `"bro"` while every merchant-facing
 * string had moved on, so every new store's assistant introduced itself with a
 * name the product no longer uses.
 *
 * Public naming: the assistant is "your mate" — an ordinary noun, lowercase.
 * A merchant overrides it per store in Settings → Assistant name, which is what
 * the white-label promise ("put your name on it, not ours") is about.
 */
export const DEFAULT_ASSISTANT_NAME = "your mate";
