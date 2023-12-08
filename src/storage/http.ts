// @ts-ignore
import got from 'got'
import { createError } from "h3";
import { getEnv } from "../utils";
import type { IPXStorage } from "../types";
export type HTTPStorageOptions = {
  fetchOptions?: RequestInit;
  maxAge?: number;
  domains?: string | string[];
  allowAllDomains?: boolean;
  ignoreCacheControl?: boolean;
};

const HTTP_RE = /^https?:\/\//;
const test=got.extend({
  dnsCache:true,
})
export function ipxHttpStorage(_options: HTTPStorageOptions = {}): IPXStorage {
  const allowAllDomains =
    _options.allowAllDomains ?? getEnv("IPX_HTTP_ALLOW_ALL_DOMAINS") ?? false;
  let _domains =
    _options.domains || getEnv<string | string[]>("IPX_HTTP_DOMAINS") || [];
  const defaultMaxAge =
    _options.maxAge || getEnv<string | number>("IPX_HTTP_MAX_AGE");

  if (typeof _domains === "string") {
    _domains = _domains.split(",").map((s) => s.trim());
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function wildcardToRegex(wildcard:string) {
    return new RegExp('^' + wildcard.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$');
  }

  const domains = new Set(
    _domains
      .map((d) => {
        if (!HTTP_RE.test(d)) {
          d = "http://" + d;
        }
        return new URL(d).hostname;
      })
      .filter(Boolean),
  );
  const hosts=_domains.filter((d) => d.startsWith('*')).map((d) => wildcardToRegex(d))

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function validateId(id: string) {
    const url = new URL(decodeURIComponent(id));
    if (!url.hostname) {
      throw createError({
        statusCode: 403,
        statusText: `IPX_MISSING_HOSTNAME`,
        message: `Hostname is missing: ${id}`,
      });
    }
    const isMatch=hosts.some(regex => regex.test(url.hostname))
    if (!isMatch&&(!allowAllDomains && !domains.has(url.hostname))) {
      throw createError({
        statusCode: 403,
        statusText: `IPX_FORBIDDEN_HOST`,
        message: `Forbidden host: ${url.hostname}`,
      });
    }
    return url.toString();
  }

  // eslint-disable-next-line unicorn/consistent-function-scoping
  function parseResponse(response: any) {
    let maxAge = defaultMaxAge;
    if (_options.ignoreCacheControl) {
      const _cacheControl = response.headers.get("cache-control");
      if (_cacheControl) {
        const m = _cacheControl.match(/max-age=(\d+)/);
        if (m && m[1]) {
          maxAge = Number.parseInt(m[1]);
        }
      }
    }

    let mtime;
    const _lastModified = response.headers["last-modified"];
    if (_lastModified) {
      mtime = new Date(_lastModified);
    }

    return { maxAge, mtime };
  }

  return {
    name: "ipx:http",
    async getMeta(id) {
      const url = validateId(id);
      try {
        const response = await test({
          url,
          method: "HEAD",
        });
        const { maxAge, mtime } = parseResponse(response as any);
        return { mtime, maxAge };
      } catch {
        return {};
      }
    },
    async getData(id) {
      const url = validateId(id);
      const response = await test( {
        url,
        method: "GET",
        responseType:'buffer',
        resolveBodyOnly:true
      });
      return response;
    },
  };
}
