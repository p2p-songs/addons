import { describe, it, expect } from "vitest";
import { isRecognizedOpenLicense } from "../src/license.js";

describe("isRecognizedOpenLicense (fail closed)", () => {
  it("accepts Creative Commons license + public-domain URLs", () => {
    for (const v of [
      "https://creativecommons.org/licenses/by/3.0/",
      "http://creativecommons.org/licenses/by-sa/4.0/",
      "https://creativecommons.org/licenses/by-nc-nd/2.0/",
      "https://creativecommons.org/publicdomain/zero/1.0/",
      "https://creativecommons.org/publicdomain/mark/1.0/",
    ]) {
      expect(isRecognizedOpenLicense(v)).toBe(true);
    }
  });

  it("accepts explicit public-domain markers", () => {
    for (const v of ["Public Domain", "CC0", "public domain", "No Known Copyright"]) {
      expect(isRecognizedOpenLicense(v)).toBe(true);
    }
  });

  it("rejects absent, empty, unknown, and all-rights-reserved values", () => {
    for (const v of [undefined, "", "   ", "All Rights Reserved", "© 2020 Label", "https://example.com/license"]) {
      expect(isRecognizedOpenLicense(v)).toBe(false);
    }
  });
});
