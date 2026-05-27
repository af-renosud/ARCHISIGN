import { test } from "node:test";
import assert from "node:assert/strict";
import { isDomainAuthorised, type ProjectedClaims } from "../GoogleAuthService";

function claims(overrides: Partial<ProjectedClaims> = {}): ProjectedClaims {
  return {
    sub: "1234567890",
    email: "alice@renosud.com",
    email_verified: true,
    first_name: "Alice",
    last_name: "Renosud",
    profile_image_url: null,
    hd: "renosud.com",
    exp: 1_900_000_000,
    ...overrides,
  };
}

test("isDomainAuthorised: accepts a Workspace identity with matching hd + email", () => {
  assert.equal(isDomainAuthorised(claims(), "renosud.com"), true);
});

test("isDomainAuthorised: rejects when hd claim is missing (personal Gmail)", () => {
  assert.equal(
    isDomainAuthorised(claims({ hd: null, email: "intruder@gmail.com" }), "renosud.com"),
    false,
  );
});

test("isDomainAuthorised: rejects when hd belongs to a different Workspace", () => {
  assert.equal(
    isDomainAuthorised(claims({ hd: "other-firm.com", email: "alice@other-firm.com" }), "renosud.com"),
    false,
  );
});

test("isDomainAuthorised: rejects when email is unverified (covers Google edge cases)", () => {
  assert.equal(isDomainAuthorised(claims({ email_verified: false }), "renosud.com"), false);
});

test("isDomainAuthorised: rejects when hd is set correctly but email is on a different domain", () => {
  // Defence-in-depth: if Google ever returns hd=renosud.com with an
  // off-domain email (shouldn't happen, but…), refuse the sign-in.
  assert.equal(
    isDomainAuthorised(claims({ email: "alice@external.example" }), "renosud.com"),
    false,
  );
});

test("isDomainAuthorised: hd comparison is case-insensitive", () => {
  assert.equal(
    isDomainAuthorised(claims({ hd: "Renosud.COM", email: "alice@RENOSUD.com" }), "renosud.com"),
    true,
  );
});
