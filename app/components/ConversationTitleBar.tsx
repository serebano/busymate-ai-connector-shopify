import { useNavigate } from "react-router";
import { TitleBar } from "@shopify/app-bridge-react";
import { useEmbeddedAppUrl } from "./EmbeddedNavigation";

export const CONVERSATIONS_PATH = "/app/conversations";

/**
 * Title bar of a page UNDER Conversations (a handoff, a transcript): the back
 * action to the parent page sits in Shopify's title bar, where every admin page
 * has it (Built for Shopify 4.1.1), next to the page's Refresh action. The pages
 * live under /app/conversations/…, so the admin keeps "Conversations" highlighted
 * in the app's navigation (4.1.4).
 */
export function ConversationTitleBar({ title, onRefresh, refreshing, disabled }: { title: string; onRefresh: () => void; refreshing: boolean; disabled?: boolean }) {
  const navigate = useNavigate();
  const parent = useEmbeddedAppUrl(CONVERSATIONS_PATH);
  return (
    <TitleBar title={title}>
      <button {...{ variant: "breadcrumb" }} onClick={() => navigate(parent)}>
        Conversations
      </button>
      <button onClick={onRefresh} disabled={disabled || refreshing} {...(refreshing ? { loading: "" } : {})}>
        Refresh
      </button>
    </TitleBar>
  );
}
