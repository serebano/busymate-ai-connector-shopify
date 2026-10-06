// Vite replaces this environment access with a build-time literal. A running old
// server cannot claim a new checkout's revision merely because Git moved on disk.
const requestedRevision = process.env.BMAI_APP_BUILD_REVISION;
export const APP_BUILD_REVISION =
  typeof requestedRevision === "string" && /^[0-9a-f]{40}$/.test(requestedRevision)
    ? requestedRevision
    : null;
