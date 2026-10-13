import { expect, test } from "vitest";
import { isPublicWebUrl } from "../convex/urlPolicy";

test("accepts ordinary public web URLs", () => {
  for (const url of ["https://v2.tauri.app/", "http://example.com/a?b=c", "https://en.wikipedia.org/wiki/Rayleigh", "https://8.8.8.8/"]) {
    expect(isPublicWebUrl(url), url).toBe(true);
  }
});

test("rejects local, private, credentialed, and non-web destinations", () => {
  for (const url of [
    "javascript:alert(1)", "file:///C:/Windows", "ftp://example.com", "not a url",
    "http://localhost:3002", "http://app.localhost/", "http://printer.local/", "http://intranet/",
    "http://127.0.0.1/", "http://0.0.0.0:3002/", "http://10.0.0.5/", "http://172.20.1.1/", "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data", "http://100.100.100.100/", "http://[::1]/", "http://[fd00::1]/",
    "https://user:pass@example.com/",
  ]) {
    expect(isPublicWebUrl(url), url).toBe(false);
  }
});
