import { describe, expect, it } from "vitest";
import { formatIPv6, parseIPv6 } from "../src/core/ip.js";
import { isPublicIp, nodeHeaderGetter, truncateIp, visitorFromHeaders } from "../src/index.js";

describe("truncateIp", () => {
  it.each([
    ["85.34.78.211", "85.34.78.0"],
    ["2a01:4f8:1c1c:abcd::1", "2a01:4f8:1c1c::"],
    ["::ffff:85.34.78.211", "85.34.78.0"],
    [" 85.34.78.211 ", "85.34.78.0"],
    ["2001:DB8:0:0:8:800:200C:417A", "2001:db8::"],
    ["not-an-ip", ""],
    ["256.1.1.1", ""],
    ["01.2.3.4", ""],
    ["1:2:3:4:5:6:7:8:9", ""],
    ["fe80::1%eth0", ""],
    ["::1::2", ""],
  ])("%j → %j", (input, expected) => {
    expect(truncateIp(input)).toBe(expected);
  });
});

describe("IPv6 parsing and RFC 5952 formatting", () => {
  it.each([
    ["::", "::"],
    ["::1", "::1"],
    ["2001:db8:0:0:1:0:0:1", "2001:db8::1:0:0:1"],
    ["2001:0db8:0000:0000:0000:0000:0002:0001", "2001:db8::2:1"],
    ["1:0:1:0:1:0:1:0", "1:0:1:0:1:0:1:0"],
    ["64:ff9b::192.0.2.33", "64:ff9b::c000:221"],
  ])("%s → %s", (input, expected) => {
    const bytes = parseIPv6(input);
    expect(bytes).not.toBeNull();
    expect(formatIPv6(bytes as Uint8Array)).toBe(expected);
  });
});

describe("isPublicIp", () => {
  it.each([
    ["85.34.78.12", true],
    ["2a01:4f8::1", true],
    ["10.1.2.3", false],
    ["172.20.0.1", false],
    ["192.168.1.1", false],
    ["127.0.0.1", false],
    ["100.64.0.1", false],
    ["169.254.1.1", false],
    ["::1", false],
    ["fd00::1", false],
    ["fe80::1", false],
    ["::ffff:10.0.0.1", false],
    ["garbage", false],
  ])("%s → %s", (ip, expected) => {
    expect(isPublicIp(ip)).toBe(expected);
  });
});

describe("visitorFromHeaders", () => {
  it("takes the first public forwarded address and the CDN country", () => {
    const get = nodeHeaderGetter({
      "x-forwarded-for": "10.0.0.1, 85.34.78.12",
      "user-agent": "UA",
      "x-vercel-ip-country": "de",
    });
    expect(visitorFromHeaders(get, "127.0.0.1")).toEqual({ ip: "85.34.78.12", userAgent: "UA", country: "de" });
  });

  it("prefers cf-connecting-ip and falls back to the socket", () => {
    expect(visitorFromHeaders(nodeHeaderGetter({ "cf-connecting-ip": "85.34.78.1", "x-forwarded-for": "85.34.78.2" })).ip).toBe("85.34.78.1");
    expect(visitorFromHeaders(nodeHeaderGetter({}), "85.34.78.3").ip).toBe("85.34.78.3");
    expect(visitorFromHeaders(nodeHeaderGetter({}), "10.0.0.3").ip).toBeUndefined();
  });
});
