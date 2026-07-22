import { describe, it, expect } from "vitest";
import { isPublicAddress, isAllowedScheme } from "../src/net/ip-policy.js";

describe("isPublicAddress — IPv4 (audit A-011)", () => {
  it.each([
    ["8.8.8.8"],
    ["1.1.1.1"],
    ["93.184.216.34"],
    ["172.15.0.1"], // just below the private 172.16/12 block
    ["172.32.0.1"], // just above it
    ["100.63.255.255"], // just below CGNAT 100.64/10
    ["100.128.0.1"], // just above it
  ])("allows public %s", (ip) => {
    expect(isPublicAddress(ip, 4)).toBe(true);
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.1.2.3", "loopback range"],
    ["0.0.0.0", "this network"],
    ["10.0.0.5", "private"],
    ["172.16.0.1", "private (low edge)"],
    ["172.31.255.255", "private (high edge)"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "cloud metadata"],
    ["100.64.0.1", "CGNAT"],
    ["192.0.2.1", "TEST-NET-1"],
    ["198.18.0.1", "benchmarking"],
    ["198.51.100.1", "TEST-NET-2"],
    ["203.0.113.1", "TEST-NET-3"],
    ["224.0.0.1", "multicast"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("denies %s (%s)", (ip) => {
    expect(isPublicAddress(ip, 4)).toBe(false);
  });

  it("denies malformed input rather than defaulting to allow", () => {
    expect(isPublicAddress("not-an-ip", 4)).toBe(false);
    expect(isPublicAddress("1.2.3", 4)).toBe(false);
    expect(isPublicAddress("1.2.3.999", 4)).toBe(false);
    expect(isPublicAddress("8.8.8.8", 0)).toBe(false); // unknown family
  });
});

describe("isPublicAddress — IPv6 (audit A-011)", () => {
  it.each([["2606:4700:4700::1111"], ["2001:4860:4860::8888"]])("allows public %s", (ip) => {
    expect(isPublicAddress(ip, 6)).toBe(true);
  });

  it.each([
    ["::1", "loopback"],
    ["::", "unspecified"],
    ["fc00::1", "unique-local"],
    ["fd12:3456::1", "unique-local"],
    ["fe80::1", "link-local"],
    ["ff02::1", "multicast"],
    ["2001:db8::1", "documentation"],
    ["64:ff9b::7f00:1", "NAT64 → v4 space"],
    ["2002:7f00:1::", "6to4 → embeds arbitrary v4"],
  ])("denies %s (%s)", (ip) => {
    expect(isPublicAddress(ip, 6)).toBe(false);
  });

  it("judges IPv4-mapped addresses by the embedded v4 address", () => {
    // ::ffff:127.0.0.1 is loopback wearing a v6 costume — the classic bypass.
    expect(isPublicAddress("::ffff:127.0.0.1", 6)).toBe(false);
    expect(isPublicAddress("::ffff:169.254.169.254", 6)).toBe(false);
    expect(isPublicAddress("::ffff:8.8.8.8", 6)).toBe(true);
  });

  /**
   * Audit A-012. The dotted spelling above is the one form `new URL()` never
   * produces: it rewrites `[::ffff:127.0.0.1]` to `[::ffff:7f00:1]`, so the
   * original regex only ever matched addresses that couldn't reach it. Classify
   * on the bits, and every spelling of one address gets one answer.
   */
  it.each([
    ["::ffff:7f00:1", "hex mapped loopback"],
    ["0:0:0:0:0:ffff:7f00:1", "fully expanded mapped loopback"],
    ["::ffff:a9fe:a9fe", "hex mapped cloud metadata"],
    ["::ffff:c0a8:101", "hex mapped 192.168.1.1"],
    ["::ffff:a00:5", "hex mapped 10.0.0.5"],
    ["::ffff:ac10:1", "hex mapped 172.16.0.1"],
    ["::ffff:0:7f00:1", "IPv4-translated loopback"],
    ["::7f00:1", "IPv4-compatible loopback"],
    ["::ffff:0:0", "mapped 0.0.0.0"],
  ])("denies %s (%s)", (ip) => {
    expect(isPublicAddress(ip, 6)).toBe(false);
  });

  it("still allows a genuinely public address in hex mapped form", () => {
    expect(isPublicAddress("::ffff:808:808", 6)).toBe(true); // 8.8.8.8
    expect(isPublicAddress("::ffff:5db8:d822", 6)).toBe(true); // 93.184.216.34
  });

  it("denies malformed input rather than defaulting to allow", () => {
    for (const ip of ["not-an-ip", "::ffff::1", "12345::1", "2001:xyz::1", "::ffff:1.2.3", "1:2:3:4:5:6:7"]) {
      expect(isPublicAddress(ip, 6)).toBe(false);
    }
  });

  it("ignores a zone index when classifying", () => {
    expect(isPublicAddress("fe80::1%eth0", 6)).toBe(false);
  });
});

describe("isAllowedScheme", () => {
  it("permits only https in public mode", () => {
    expect(isAllowedScheme("https:", false)).toBe(true);
    expect(isAllowedScheme("http:", false)).toBe(false);
  });

  it("permits http in self-host mode (a local Jackett is plain http)", () => {
    expect(isAllowedScheme("http:", true)).toBe(true);
  });

  it("never permits anything else", () => {
    for (const scheme of ["file:", "ftp:", "gopher:", "data:", "javascript:"]) {
      expect(isAllowedScheme(scheme, true)).toBe(false);
      expect(isAllowedScheme(scheme, false)).toBe(false);
    }
  });
});
