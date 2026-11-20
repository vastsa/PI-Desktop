/**
 * Contract test for which avatar address the GitHub card will load (ADR
 * github-connector).
 *
 * The avatar URL comes from the stored credential record. Loading whatever
 * that names would let a planted or damaged record make Settings fetch an
 * arbitrary address every time the page opens, so the card loads an avatar
 * only from GitHub's avatar host and shows its placeholder for anything else.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { githubAvatarSource } from "../src/features/settings/connectors/github-avatar.ts";

test("an avatar on GitHub's avatar host is loaded as it is", () => {
  for (const url of [
    "https://avatars.githubusercontent.com/u/583231?v=4",
    "https://avatars.githubusercontent.com/in/15368?s=64",
    "https://AVATARS.githubusercontent.com/u/1",
  ]) {
    assert.equal(githubAvatarSource(url), url);
  }
});

test("any other address is not loaded", () => {
  for (const url of [
    "https://evil.example/track.png",
    "https://avatars.githubusercontent.com.evil.example/u/1",
    "https://evil.example/avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com@evil.example/u/1",
    "https://user:pass@avatars.githubusercontent.com/u/1",
    "https://avatars.githubusercontent.com:8443/u/1",
    "http://avatars.githubusercontent.com/u/1",
    "//avatars.githubusercontent.com/u/1",
    "https://github.com/octocat.png",
    "data:image/png;base64,AAAA",
    "javascript:alert(1)",
    "file:///etc/passwd",
    "not a url",
    "",
    undefined,
    null,
    42,
  ]) {
    assert.equal(githubAvatarSource(url), null, String(url));
  }
});
