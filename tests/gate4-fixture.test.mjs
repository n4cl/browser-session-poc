import assert from "node:assert/strict";
import test from "node:test";

import {
  createGate4FixtureServer,
  escapeHtml,
  fixtureReadyLine,
  GATE4_FIXTURE_MARKER_MAX_LENGTH,
  GATE4_FIXTURE_STORAGE_KEY,
  parseFixtureArguments,
} from "../scripts/gate4-fixture.mjs";

async function responseText(response) {
  return response.text();
}

test("Gate 4 fixture arguments are strict and default to an ephemeral port", () => {
  assert.deepEqual(parseFixtureArguments([]), { port: 0 });
  assert.deepEqual(parseFixtureArguments(["--port", "0"]), { port: 0 });
  assert.deepEqual(parseFixtureArguments(["--port", "43123"]), { port: 43123 });
  for (const argv of [
    ["--port"],
    ["--port", "01"],
    ["--port", "1.5"],
    ["--port", "-1"],
    ["--port", "65536"],
    ["--port", "1", "extra"],
    ["--host", "127.0.0.1"],
  ]) {
    assert.throws(() => parseFixtureArguments(argv), /usage/);
  }
});

test("fixture escapes marker HTML and keeps the ready output fixed", () => {
  assert.equal(escapeHtml(`<A&"'>`), "&lt;A&amp;&quot;&#39;&gt;");
  assert.equal(fixtureReadyLine({ origin: "http://127.0.0.1:43123" }), "gate4-fixture ready http://127.0.0.1:43123/\n");
  assert.throws(() => fixtureReadyLine({ origin: "http://localhost:43123" }), /origin/);
});

test("fixture serves a same-origin storage page without arbitrary file access", async (t) => {
  const fixture = await createGate4FixtureServer();
  t.after(() => fixture.close());

  assert.match(fixture.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  assert.equal(fixture.url, `${fixture.origin}/`);
  assert.ok(fixture.port > 0);

  const marker = `<A&"'>`;
  const pageResponse = await fetch(`${fixture.url}?marker=${encodeURIComponent(marker)}`);
  const pageBody = await responseText(pageResponse);
  assert.equal(pageResponse.status, 200);
  assert.match(pageResponse.headers.get("content-type"), /^text\/html; charset=utf-8$/u);
  assert.equal(pageResponse.headers.get("cache-control"), "no-store");
  assert.equal(pageResponse.headers.get("cross-origin-resource-policy"), "same-origin");
  assert.equal(pageResponse.headers.get("referrer-policy"), "no-referrer");
  assert.equal(pageResponse.headers.get("x-content-type-options"), "nosniff");
  assert.match(pageResponse.headers.get("content-security-policy"), /default-src 'self'/u);
  assert.match(pageBody, /id="marker-form"/u);
  assert.match(pageBody, /role="status"/u);
  assert.match(pageBody, new RegExp(`maxlength="${GATE4_FIXTURE_MARKER_MAX_LENGTH}"`, "u"));
  assert.match(pageBody, /value="&lt;A&amp;&quot;&#39;&gt;"/u);
  assert.doesNotMatch(pageBody, /value="<A&"'>"/u);
  assert.doesNotMatch(pageBody, /\/Users\/|package\.json|node_modules/u);

  const scriptResponse = await fetch(`${fixture.origin}/fixture.js`);
  const scriptBody = await responseText(scriptResponse);
  assert.equal(scriptResponse.status, 200);
  assert.equal(scriptResponse.headers.get("cache-control"), "no-store");
  assert.match(scriptResponse.headers.get("content-type"), /^application\/javascript; charset=utf-8$/u);
  assert.match(scriptBody, new RegExp(`const STORAGE_KEY = ${JSON.stringify(GATE4_FIXTURE_STORAGE_KEY)};`, "u"));
  assert.match(scriptBody, /localStorage\.setItem/u);
  assert.match(scriptBody, /document\.cookie/u);

  const healthResponse = await fetch(`${fixture.origin}/healthz`);
  assert.equal(healthResponse.status, 200);
  assert.equal(await responseText(healthResponse), "ok\n");
  assert.equal(healthResponse.headers.get("cache-control"), "no-store");

  const packageResponse = await fetch(`${fixture.origin}/package.json`);
  assert.equal(packageResponse.status, 404);
  assert.equal(await responseText(packageResponse), "not found\n");
});

test("fixture rejects invalid methods, paths, and marker bounds", async (t) => {
  const fixture = await createGate4FixtureServer();
  t.after(() => fixture.close());

  const methodResponse = await fetch(fixture.url, { method: "POST" });
  assert.equal(methodResponse.status, 405);
  assert.equal(await responseText(methodResponse), "method not allowed\n");

  const emptyMarkerResponse = await fetch(`${fixture.url}?marker=`);
  assert.equal(emptyMarkerResponse.status, 400);
  assert.equal(await responseText(emptyMarkerResponse), "invalid marker\n");

  const longMarkerResponse = await fetch(`${fixture.url}?marker=${"x".repeat(GATE4_FIXTURE_MARKER_MAX_LENGTH + 1)}`);
  assert.equal(longMarkerResponse.status, 400);

  const controlMarkerResponse = await fetch(`${fixture.url}?marker=${encodeURIComponent("ok\u0001")}`);
  assert.equal(controlMarkerResponse.status, 400);

  const maxMarkerResponse = await fetch(`${fixture.url}?marker=${"x".repeat(GATE4_FIXTURE_MARKER_MAX_LENGTH)}`);
  assert.equal(maxMarkerResponse.status, 200);
  assert.equal(((await responseText(maxMarkerResponse)).match(/value="x"/gu) ?? []).length, 0);

  const missingResponse = await fetch(`${fixture.origin}/not-a-file`);
  assert.equal(missingResponse.status, 404);
  assert.equal(await responseText(missingResponse), "not found\n");

  const authorityFormResponse = await fetch(`${fixture.origin}//other-origin.test/`);
  assert.equal(authorityFormResponse.status, 400);
  assert.equal(await responseText(authorityFormResponse), "bad request\n");
});
