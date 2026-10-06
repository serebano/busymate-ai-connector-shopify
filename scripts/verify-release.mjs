import { pathToFileURL } from "node:url";

export function verifyRelease(expected, text) {
  if (!/^[0-9a-f]{40}$/.test(expected || "")) throw new Error("Invalid expected release revision");
  if (Buffer.byteLength(text) > 65536) throw new Error("Release response exceeds limit");
  let status;
  try { status = JSON.parse(text); } catch { throw new Error("Release response is not JSON"); }
  if (status?.ok !== true || status?.revision !== expected) {
    throw new Error("Live service does not prove the requested revision");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 65536) throw new Error("Release response exceeds limit");
    }
    verifyRelease(process.argv[2], input);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
