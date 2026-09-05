import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  classifyKey,
  DEMO_ERP_HOSTS,
  DEMO_ERP_URL,
  demoErpRefusal,
  describeSecret,
  hostOf,
  isDemoErpHost,
  liveErpUrl,
  loadConfig,
  type Config,
} from "./env.js";

/** A Config as loadConfig() builds it for a live run against a real ERP; override what a test cares about. */
function config(overrides: Partial<Config> = {}): Config {
  const erpOnboardingUrl = overrides.erpOnboardingUrl ?? "https://erp.example.com/onboarding";
  return {
    erpOnboardingUrl,
    erpUrlIsDemoDefault: false,
    erpHostIsDemoEcho: isDemoErpHost(hostOf(erpOnboardingUrl)),
    allowDemoErp: false,
    env: "testnet",
    trust: "manifest",
    contractTail: "kyb",
    contractVersion: "0.1.0",
    wasmPath: "/nonexistent/z_tenant_kyb.wasm",
    ...overrides,
  };
}

const HEX64 = "a".repeat(32) + "1".repeat(32);

describe("classifyKey", () => {
  it("recognises a 32-byte hex secp256k1 private key, with or without 0x", () => {
    expect(classifyKey(HEX64)).toBe("eth-private-key");
    expect(classifyKey(`0x${HEX64}`)).toBe("eth-private-key");
    expect(classifyKey(HEX64.toUpperCase())).toBe("eth-private-key");
  });

  it("recognises an opaque t3n_key_ token", () => {
    expect(classifyKey("t3n_key_abc123")).toBe("t3n-api-key");
  });

  it("never guesses: wrong length, wrong prefix case, or empty is unknown", () => {
    expect(classifyKey(HEX64.slice(1))).toBe("unknown");
    expect(classifyKey(`${HEX64}0`)).toBe("unknown");
    expect(classifyKey(`0x${HEX64}0`)).toBe("unknown");
    expect(classifyKey("T3N_KEY_abc")).toBe("unknown");
    expect(classifyKey("")).toBe("unknown");
  });
});

describe("describeSecret", () => {
  it("reports presence and length only", () => {
    expect(describeSecret(undefined)).toBe("not set");
    expect(describeSecret("")).toBe("not set");
    expect(describeSecret("hunter22")).toBe("set (8 chars)");
    expect(describeSecret("hunter22")).not.toContain("hunter22");
  });
});

describe("hostOf", () => {
  it("returns the lower-cased hostname without port, path or query", () => {
    expect(hostOf("https://erp.example.com:8443/onboard?x=1")).toBe("erp.example.com");
    expect(hostOf("HTTPS://ERP.Example.COM/")).toBe("erp.example.com");
  });

  it("throws on a non-URL", () => {
    expect(() => hostOf("not a url")).toThrow();
  });
});

describe("isDemoErpHost", () => {
  it("matches every listed echo service, its subdomains, and ignores case", () => {
    for (const h of DEMO_ERP_HOSTS) {
      expect(isDemoErpHost(h)).toBe(true);
      expect(isDemoErpHost(`eu.${h}`)).toBe(true);
      expect(isDemoErpHost(h.toUpperCase())).toBe(true);
    }
  });

  it("rejects real hosts and look-alikes", () => {
    expect(isDemoErpHost("erp.example.com")).toBe(false);
    expect(isDemoErpHost("nothttpbin.org")).toBe(false);
    expect(isDemoErpHost("httpbin.org.evil.example")).toBe(false);
    expect(isDemoErpHost("httpbin.orgx")).toBe(false);
    expect(isDemoErpHost("")).toBe(false);
  });

  it("agrees with DEMO_ERP_URL (the dry-run default is itself an echo service)", () => {
    expect(isDemoErpHost(hostOf(DEMO_ERP_URL))).toBe(true);
  });
});

describe("demoErpRefusal", () => {
  it("allows a real ERP", () => {
    expect(demoErpRefusal(config())).toBeUndefined();
  });

  it("refuses an echo service by default and names the host and the override", () => {
    const refusal = demoErpRefusal(config({ erpOnboardingUrl: "https://httpbin.org/post" }));
    expect(refusal).toContain("httpbin.org");
    expect(refusal).toContain("--allow-demo-erp");
    expect(refusal).toContain("KYB_ALLOW_DEMO_ERP=1");
  });

  it("allows an echo service once the operator opted in", () => {
    expect(demoErpRefusal(config({ erpOnboardingUrl: "https://httpbin.org/post", allowDemoErp: true }))).toBeUndefined();
  });
});

describe("liveErpUrl", () => {
  it("returns the configured real ERP URL", () => {
    expect(liveErpUrl(config())).toBe("https://erp.example.com/onboarding");
  });

  it("refuses the substituted demo default even when demo hosts are allowed", () => {
    const cfg = config({ erpOnboardingUrl: DEMO_ERP_URL, erpUrlIsDemoDefault: true, allowDemoErp: true });
    expect(() => liveErpUrl(cfg)).toThrow(/ERP_ONBOARDING_URL is not set/);
  });

  it("refuses an explicit echo service without the opt-in, and accepts it with", () => {
    expect(() => liveErpUrl(config({ erpOnboardingUrl: "https://httpbin.org/post" }))).toThrow(/public request-echo service/);
    expect(liveErpUrl(config({ erpOnboardingUrl: "https://httpbin.org/post", allowDemoErp: true }))).toBe("https://httpbin.org/post");
  });
});

describe("loadConfig", () => {
  // loadConfig() also reads cli/.env when present, so every case below sets its variables explicitly
  // (exported variables win over the file). The "ERP_ONBOARDING_URL unset -> DEMO_ERP_URL" default is
  // not asserted here because a developer's cli/.env may define it; isDemoErpHost covers the constant.
  const VARS = ["T3N_ENV", "T3N_TRUST", "ERP_ONBOARDING_URL", "KYB_ALLOW_DEMO_ERP", "CONTRACT_VERSION", "CONTRACT_TAIL"] as const;
  let saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    saved = Object.fromEntries(VARS.map((k) => [k, process.env[k]]));
    process.env.T3N_ENV = "testnet";
    process.env.T3N_TRUST = "manifest";
    process.env.ERP_ONBOARDING_URL = "https://erp.example.com/onboarding";
    delete process.env.KYB_ALLOW_DEMO_ERP;
  });

  afterEach(() => {
    for (const k of VARS) {
      const v = saved[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("rejects an unknown T3N_ENV or T3N_TRUST", () => {
    process.env.T3N_ENV = "mainnet";
    expect(() => loadConfig()).toThrow(/T3N_ENV must be one of/);
    process.env.T3N_ENV = "testnet";
    process.env.T3N_TRUST = "trust-me";
    expect(() => loadConfig()).toThrow(/T3N_TRUST must be one of/);
  });

  it("refuses unsafe trust on production", () => {
    process.env.T3N_ENV = "production";
    process.env.T3N_TRUST = "unsafe";
    expect(() => loadConfig()).toThrow(/refused on production/);
    process.env.T3N_TRUST = "manifest";
    expect(loadConfig().env).toBe("production");
  });

  it("rejects a malformed ERP_ONBOARDING_URL", () => {
    process.env.ERP_ONBOARDING_URL = "erp.example.com/onboarding";
    expect(() => loadConfig()).toThrow(/not a valid URL/);
  });

  it("flags an explicit echo-service URL and honours the opt-in from env var or flag", () => {
    process.env.ERP_ONBOARDING_URL = "https://httpbin.org/post";
    const plain = loadConfig();
    expect(plain.erpUrlIsDemoDefault).toBe(false);
    expect(plain.erpHostIsDemoEcho).toBe(true);
    expect(plain.allowDemoErp).toBe(false);
    expect(loadConfig({ allowDemoErp: true }).allowDemoErp).toBe(true);
    process.env.KYB_ALLOW_DEMO_ERP = "1";
    expect(loadConfig().allowDemoErp).toBe(true);
  });

  it("does not flag a real ERP host", () => {
    const cfg = loadConfig();
    expect(cfg.erpHostIsDemoEcho).toBe(false);
    expect(cfg.erpUrlIsDemoDefault).toBe(false);
  });

  it("takes CONTRACT_VERSION and CONTRACT_TAIL from the environment", () => {
    process.env.CONTRACT_VERSION = "9.9.9";
    process.env.CONTRACT_TAIL = "kyb-next";
    const cfg = loadConfig();
    expect(cfg.contractVersion).toBe("9.9.9");
    expect(cfg.contractTail).toBe("kyb-next");
  });
});
