# Exact app-host delivery (#41)

The tag/manual app-server workflow replaces its successful echo placeholder with
the existing SETUP3b host sequence. It verifies that the requested full commit is
protected-main history, refuses a dirty checkout, prints the previous rollback
commit, serializes releases, builds/migrates as deploy and restarts the existing
unit. Its pass condition is public status `ok:true` plus the exact build-time
revision. A running unit or a stale healthy response is insufficient.

Access prerequisites are DEPLOY_HOST (authorized root SSH destination),
DEPLOY_SSH_KEY and pinned DEPLOY_KNOWN_HOSTS. Missing access fails before SSH.
Temporary key files are private and removed by this invocation's EXIT trap;
secret values are not command arguments or logs. Provisioning repository secrets,
production migration compatibility and an actual release remain owner operations.
No workflow dispatch, host connection, production mutation or real deployment was
performed while implementing this change.

Local verification: nine owning deployment/revision tests pass, including actual
script execution under stubbed host commands, failed build/no restart, dirty and
off-main refusal, stale public revision/no success, credential/destination refusal,
private key transport/cleanup and immutable compiled revision. The full suite
passes 763/763 across76files. Typecheck, lint and the ordinary SSR build pass.
The initial test fixture template-escape error is corrected; it was not a product
failure. A final compiled loopback revision readback is recorded separately.

Main CI says explicitly that validation did not deploy. The separate Shopify
extension/config job retains its existing CLI credential/command path; that path
is not proven by app-host delivery and must follow SETUP3e. No App Store review
or provider approval is inferred from local or host release checks.
