import { RpcError } from "@terminal3/t3n-sdk";
import { describe, expect, it } from "vitest";
import type { Config } from "./env.js";
import { explainError, messageChain, redact, secretsOf } from "./errors.js";

const BASE: Config = {
  erpOnboardingUrl: "https://erp.example.com/onboarding",
  erpUrlIsDemoDefault: false,
  erpHostIsDemoEcho: false,
  allowDemoErp: false,
  env: "testnet",
  trust: "manifest",
  contractTail: "kyb",
  contractVersion: "0.1.0",
  wasmPath: "/nonexistent/z_tenant_kyb.wasm",
};

describe("redact", () => {
  it("replaces every occurrence of every secret", () => {
    expect(redact("a=t3n_key_abcdef b=t3n_key_abcdef", ["t3n_key_abcdef"])).toBe("a=[redacted] b=[redacted]");
    expect(redact("k1 SECRET_ONE k2 SECRET_TWO", ["SECRET_ONE", "SECRET_TWO"])).toBe("k1 [redacted] k2 [redacted]");
  });

  it("skips undefined and short values (a 4-char secret would blank ordinary text)", () => {
    expect(redact("pin 1234 here", [undefined, "1234"])).toBe("pin 1234 here");
    expect(redact("x 1234567 y", ["1234567"])).toBe("x 1234567 y");
    expect(redact("x 12345678 y", ["12345678"])).toBe("x [redacted] y");
  });

  it("is the identity without secrets", () => {
    expect(redact("nothing to hide", [])).toBe("nothing to hide");
  });
});

describe("secretsOf", () => {
  it("is empty before the config loads", () => {
    expect(secretsOf(undefined)).toEqual([]);
  });

  it("lists the four configured keys in a fixed order, undefined where unset", () => {
    expect(secretsOf({ ...BASE, t3nApiKey: "t3n_key_one", erpApiKey: "erp-key-two" })).toEqual([
      "t3n_key_one",
      undefined,
      undefined,
      "erp-key-two",
    ]);
  });
});

describe("messageChain", () => {
  it("prints a plain Error's message without the generic name", () => {
    expect(messageChain(new Error("boom"))).toBe("boom");
  });

  it("prefixes a specific error name", () => {
    expect(messageChain(new TypeError("bad type"))).toBe("TypeError: bad type");
  });

  it("walks the cause chain outermost first", () => {
    const e = new Error("outer", { cause: new Error("middle", { cause: new RangeError("inner") }) });
    expect(messageChain(e)).toBe("outer ← middle ← RangeError: inner");
  });

  it("stringifies non-Error values", () => {
    expect(messageChain("boom")).toBe("boom");
    expect(messageChain(42)).toBe("42");
  });

  it("stops after six links", () => {
    let e: Error = new Error("e0");
    for (let i = 1; i <= 8; i++) e = new Error(`e${i}`, { cause: e });
    const chain = messageChain(e);
    expect(chain.split(" ← ")).toHaveLength(6);
    expect(chain).toContain("e3");
    expect(chain).not.toContain("e2");
  });
});

describe("explainError", () => {
  it("starts with the message chain and adds no hint for an unrecognised message", () => {
    const out = explainError(new Error("something unrelated happened"));
    expect(out.split("\n")[0]).toBe("something unrelated happened");
    expect(out).not.toContain("hint:");
  });

  // One representative message per hint family, with a fragment unique to that hint's text.
  const HINTED: ReadonlyArray<readonly [message: string, hintFragment: string]> = [
    ["Version 0.1.0 is not higher than current version 0.1.0", "Bump CONTRACT_VERSION"],
    ["map already exists", "Idempotent"],
    ["map not found: z:abc:secrets", "Map tail mismatch"],
    ["host/http.egress_denied", "kyb authorize"],
    ["InsufficientCredit (account=3a8281aa, required=10000000000, available=0)", "CALLING identity"],
    ["access denied: contract 879 cannot read map z:abc:secrets", "readers/writers ACL"],
    ["PlaceholderNoUserContext", "--on-behalf-of"],
    ["Invalid action request", "Wire-shape mismatch"],
    ["Trust manifest at https://node.example/api/trust-manifest is malformed.", "pins 5.2.0"],
    ["manifest signature verification failed", "operator key"],
    ["DKG attestation verification failed", "Node attestation"],
    ["fetch failed", "Network:"],
    ["connect ECONNREFUSED 127.0.0.1:443", "Network:"],
    ["Invalid Ethereum private key", "64-hex"],
    ["invoke request failed (400)", "hides the response body"],
    ["tenant is suspended", "suspended this tenant"],
    ["quota exceeded", "quota is exhausted"],
    ["did:t3n:abc is not a tenant", "--claim"],
  ];
  for (const [message, fragment] of HINTED) {
    it(`hints on "${message}"`, () => {
      const out = explainError(new Error(message));
      expect(out).toContain("hint: ");
      expect(out).toContain(fragment);
    });
  }

  it("appends every matching hint", () => {
    const out = explainError(new Error("map not found, then egress_denied"));
    expect(out).toContain("Map tail mismatch");
    expect(out).toContain("kyb authorize");
  });

  it("prints RPC facts and matches hints against the node's detail", () => {
    const out = explainError(new RpcError("rpc call failed", "tenant.createMap", 409, "map already exists", "req-123"));
    expect(out).toContain("rpc method: tenant.createMap");
    expect(out).toContain("status: 409");
    expect(out).toContain("detail: map already exists");
    expect(out).toContain("request_id: req-123");
    expect(out).toContain("Idempotent");
  });

  it("finds an RpcError wrapped as a cause", () => {
    const rpc = new RpcError("rpc call failed", "tenant.register", 400, undefined, "req-456");
    const out = explainError(new Error("deploy failed", { cause: rpc }));
    expect(out).toContain("rpc method: tenant.register");
    expect(out).toContain("request_id: req-456");
  });

  it("never matches hints against its own report lines (regression: the request_id line once matched /quote/)", () => {
    const out = explainError(new RpcError("unexpected server state", "tenant.register", 500, undefined, "req-789"));
    expect(out).toContain("quote this when reporting");
    expect(out).not.toContain("hint:");
  });

  it("redacts configured secrets from everything it prints", () => {
    const out = explainError(new RpcError("bad key t3n_key_leaked1", "invoke", 401, "key t3n_key_leaked1 rejected"), ["t3n_key_leaked1"]);
    expect(out).not.toContain("t3n_key_leaked1");
    expect(out).toContain("[redacted]");
  });

  it("never throws, whatever is thrown at it", () => {
    for (const v of [undefined, null, 42, "boom", {}, [], Symbol("s")]) {
      expect(() => explainError(v)).not.toThrow();
      expect(typeof explainError(v)).toBe("string");
    }
    expect(explainError("boom")).toBe("boom");
  });
});
