"use strict";
// Minimal in-memory cookie jar for bounded source transfers. Publishers such as
// nature.com set a session cookie on the first redirect hop and refuse the PDF
// without it. Cookies live only for one acquisition session and never reach
// models, logs or saved metadata.
const LIMITS = Object.freeze({ cookies: 200, bytes: 4096 });

function canonicalHost(url) {
  return url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
}

function domainMatches(host, domain) {
  return host === domain || (host.endsWith("." + domain) && !/^\d+(?:\.\d+){3}$/.test(host));
}

function defaultPath(url) {
  const path = url.pathname || "/";
  if (!path.startsWith("/") || path === "/") return "/";
  const last = path.lastIndexOf("/");
  return last <= 0 ? "/" : path.slice(0, last);
}

function pathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith("/") || requestPath[cookiePath.length] === "/";
}

class CookieJar {
  constructor({ now = Date.now } = {}) { this.cookies = []; this.now = now; }

  store(value, setCookie) {
    const url = value instanceof URL ? value : new URL(value);
    const host = canonicalHost(url);
    for (const line of Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : []) {
      if (typeof line !== "string" || line.length > LIMITS.bytes) continue;
      const [pair, ...parts] = line.split(";");
      const index = pair.indexOf("=");
      if (index < 1) continue;
      const name = pair.slice(0, index).trim(), cookieValue = pair.slice(index + 1).trim();
      if (!name || /[\x00-\x20()<>@,;:\\"/[\]?={}\x7f]/.test(name)) continue;
      const attributes = {};
      for (const part of parts) {
        const separator = part.indexOf("=");
        const key = (separator < 0 ? part : part.slice(0, separator)).trim().toLowerCase();
        attributes[key] = separator < 0 ? "" : part.slice(separator + 1).trim();
      }
      let domain = host, hostOnly = true;
      if (attributes.domain) {
        const declared = attributes.domain.replace(/^\./, "").toLowerCase();
        // Reject foreign and single-label domains; a cookie may only widen to a parent of its own host.
        if (!declared.includes(".") || !domainMatches(host, declared)) continue;
        domain = declared; hostOnly = false;
      }
      const path = attributes.path?.startsWith("/") ? attributes.path : defaultPath(url);
      let expires = Infinity;
      if (attributes["max-age"] !== undefined && /^-?\d+$/.test(attributes["max-age"])) expires = this.now() + Number(attributes["max-age"]) * 1000;
      else if (attributes.expires) { const parsed = Date.parse(attributes.expires); if (!Number.isNaN(parsed)) expires = parsed; }
      this.cookies = this.cookies.filter(cookie => !(cookie.name === name && cookie.domain === domain && cookie.path === path));
      if (expires <= this.now()) continue;
      this.cookies.push({ name, value: cookieValue, domain, hostOnly, path, secure: "secure" in attributes, expires });
      if (this.cookies.length > LIMITS.cookies) this.cookies.splice(0, this.cookies.length - LIMITS.cookies);
    }
  }

  header(value) {
    const url = value instanceof URL ? value : new URL(value);
    const host = canonicalHost(url), now = this.now();
    this.cookies = this.cookies.filter(cookie => cookie.expires > now);
    return this.cookies
      .filter(cookie => (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain))
        && pathMatches(url.pathname || "/", cookie.path) && (!cookie.secure || url.protocol === "https:"))
      .sort((a, b) => b.path.length - a.path.length)
      .map(cookie => `${cookie.name}=${cookie.value}`).join("; ");
  }

  get size() { return this.cookies.length; }
}

module.exports = { CookieJar, LIMITS };
