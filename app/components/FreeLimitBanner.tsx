import { Banner } from "@shopify/polaris";
import { LocalTime } from "./LocalTime";

/**
 * The Free plan's allowance is used for this billing cycle. Says exactly what now happens (the
 * listing's promise: "then conversations route to your team") and offers the upgrade, which opens
 * Shopify's own plan page (Shopify App Pricing; this app never bills off Shopify).
 */
export function FreeLimitBanner({ used, included, resetsAt, onUpgrade }: {
  used: number;
  included: number;
  resetsAt: string | null;
  onUpgrade: () => void;
}) {
  return (
    <Banner tone="warning" title={`You've used this month's ${included} free AI resolutions`} action={{ content: "Upgrade", onAction: onUpgrade }}>
      <p>
        {used} of {included} included resolutions used. New shopper conversations now go to your team in Conversations
        instead of getting an AI answer
        {resetsAt ? (
          <>
            {" "}until your allowance resets on <LocalTime iso={resetsAt} dateOnly />
          </>
        ) : null}
        . Your storefront chat stays on. Upgrade on Shopify&apos;s pricing page to keep your mate answering every shopper.
      </p>
    </Banner>
  );
}
