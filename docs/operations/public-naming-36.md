# Public naming guard (#36)

The main default assistant name was already centralized as `your mate` in
`app/lib/assistantName.ts` and reused by provisioning/settings. Public docs, legal
copy and GitHub description also use that name. This change finishes the preserved
documentation PR and corrects its test guidance: the actual merchant-facing guard
now rejects all three retired names (`bro`, `eve`, `bmai`). It keeps word boundaries
so ordinary words such as `proven` remain valid, and excludes internal code comments
as before. It does not rename existing merchant customization or seed a tenant.

The current-main source guard accepted a `Meet bro` negative fixture; the corrected
guard refuses it. Owning tests cover each retired spelling and the public-name
positive control. Current docs retain their approved content and default behavior.
Pre-integration local checks passed typecheck/lint/build and755tests; final hosted
checks validate the branch after the app-host delivery PR is merged into it.

This is source/documentation acceptance. No provider submission, customer operation
or live merchant install was performed.
