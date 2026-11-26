# Deploying to Kubernetes: never `kubectl apply` the shopify manifests by hand

The app runs on k8s.efir.is (ns `bmai`). The manifests live in `busymate-ai-infra` (`base/app`), and the image bump goes there by PR.
To apply them use ONLY `busymate-ai-infra/scripts/apply-shopify.sh [--dry-run]`. It holds a host-wide lock
(`/tmp/bm-shopify-deploy.lock`), refuses an infra checkout behind `origin/main`, refuses an image whose connector sha is not
the same as or a descendant of the revision live at `https://store.busymate.ai/api/bmai/status`, always uses `-n bmai`, and waits for the rollouts.

Why: 2026-11-26 09:31Z two helpers deployed minutes apart and the older image (370f11c17) was applied over the newer (545144824), rolling live back briefly.
After a deploy, verify the live `revision` from the status endpoint yourself.
