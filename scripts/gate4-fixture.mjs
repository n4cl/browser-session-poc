#!/usr/bin/env node

import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

export const GATE4_FIXTURE_HOST = "127.0.0.1";
export const GATE4_FIXTURE_MARKER_MAX_LENGTH = 128;
export const GATE4_FIXTURE_STORAGE_KEY = "gate4_fixture_marker";

const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001F\u007F]/u;
const PORT_PATTERN = /^(0|[1-9]\d*)$/u;

const FIXTURE_SCRIPT = `(() => {
  "use strict";
  const STORAGE_KEY = ${JSON.stringify(GATE4_FIXTURE_STORAGE_KEY)};
  const MAX_LENGTH = ${GATE4_FIXTURE_MARKER_MAX_LENGTH};
  const controlCharacters = /[\\u0000-\\u001F\\u007F]/u;
  const input = document.getElementById("marker-input");
  const form = document.getElementById("marker-form");
  const error = document.getElementById("storage-error");
  const markerValue = document.getElementById("marker-value");
  const cookieValue = document.getElementById("cookie-value");
  const localStorageValue = document.getElementById("local-storage-value");
  const matchValue = document.getElementById("storage-match");

  function validMarker(value) {
    return typeof value === "string" && value.length > 0 && value.length <= MAX_LENGTH && !controlCharacters.test(value);
  }

  function readCookie() {
    const prefix = STORAGE_KEY + "=";
    const entry = document.cookie.split(";").map((candidate) => candidate.trim()).find((candidate) => candidate.startsWith(prefix));
    if (!entry) return "";
    try {
      return decodeURIComponent(entry.slice(prefix.length));
    } catch {
      return "";
    }
  }

  function render() {
    let stored = "";
    try {
      stored = localStorage.getItem(STORAGE_KEY) || "";
    } catch {
      stored = "";
    }
    const cookie = readCookie();
    markerValue.textContent = stored;
    cookieValue.textContent = cookie;
    localStorageValue.textContent = stored;
    matchValue.textContent = validMarker(stored) && stored === cookie ? "true" : "false";
    if (document.activeElement !== input) input.value = stored;
  }

  function save(value) {
    if (!validMarker(value)) {
      error.textContent = "marker rejected";
      return;
    }
    try {
      localStorage.setItem(STORAGE_KEY, value);
      document.cookie = STORAGE_KEY + "=" + encodeURIComponent(value) + "; Max-Age=31536000; Path=/; SameSite=Lax";
      error.textContent = "";
      render();
    } catch {
      error.textContent = "storage unavailable";
    }
  }

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    save(input.value);
  });

  if (input.value) save(input.value);
  else render();
})();
`;

function isValidMarker(value) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= GATE4_FIXTURE_MARKER_MAX_LENGTH && !CONTROL_CHARACTER_PATTERN.test(value);
}

export function escapeHtml(value) {
  if (typeof value !== "string") throw new TypeError("HTML value must be a string");
  return value.replace(/[&<>"']/gu, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function page(initialMarker) {
  const escapedMarker = escapeHtml(initialMarker);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Gate 4 storage fixture</title>
</head>
<body>
  <main>
    <h1>Gate 4 storage fixture</h1>
    <p>Same-origin profile storage test page.</p>
    <form id="marker-form">
      <label for="marker-input">Marker</label>
      <input id="marker-input" name="marker" maxlength="${GATE4_FIXTURE_MARKER_MAX_LENGTH}" value="${escapedMarker}" autocomplete="off">
      <button type="submit">Save marker</button>
    </form>
    <p id="storage-error" role="alert"></p>
    <section id="storage-status" aria-label="Storage status" role="status" aria-live="polite">
      <dl>
        <dt>Stored marker</dt><dd id="marker-value"></dd>
        <dt>Cookie marker</dt><dd id="cookie-value"></dd>
        <dt>localStorage marker</dt><dd id="local-storage-value"></dd>
        <dt>Cookie/localStorage match</dt><dd id="storage-match">false</dd>
      </dl>
    </section>
  </main>
  <script src="/fixture.js" defer></script>
</body>
</html>
`;
}

function securityHeaders(contentType) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    "Content-Type": contentType,
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  };
}

function send(response, statusCode, contentType, body) {
  response.writeHead(statusCode, securityHeaders(contentType));
  response.end(body);
}

function requestPath(request) {
  if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//")) {
    return null;
  }
  try {
    return new URL(request.url, "http://127.0.0.1/");
  } catch {
    return null;
  }
}

function handleRequest(request, response) {
  if (request.method !== "GET") {
    send(response, 405, "text/plain; charset=utf-8", "method not allowed\n");
    return;
  }
  const url = requestPath(request);
  if (url === null) {
    send(response, 400, "text/plain; charset=utf-8", "bad request\n");
    return;
  }
  if (url.pathname === "/healthz") {
    send(response, 200, "text/plain; charset=utf-8", "ok\n");
    return;
  }
  if (url.pathname === "/fixture.js") {
    send(response, 200, "application/javascript; charset=utf-8", FIXTURE_SCRIPT);
    return;
  }
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    send(response, 404, "text/plain; charset=utf-8", "not found\n");
    return;
  }
  const marker = url.searchParams.get("marker");
  if (marker !== null && !isValidMarker(marker)) {
    send(response, 400, "text/plain; charset=utf-8", "invalid marker\n");
    return;
  }
  send(response, 200, "text/html; charset=utf-8", page(marker || ""));
}

export async function createGate4FixtureServer({ port = 0 } = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("port must be an integer between 0 and 65535");
  }
  const server = http.createServer(handleRequest);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen({ host: GATE4_FIXTURE_HOST, port });
  });
  const address = server.address();
  if (!address || typeof address === "string" || !Number.isSafeInteger(address.port)) {
    await new Promise((resolve) => server.close(() => resolve()));
    throw new Error("fixture listener address is unavailable");
  }
  let closePromise;
  return Object.freeze({
    origin: `http://${GATE4_FIXTURE_HOST}:${address.port}`,
    url: `http://${GATE4_FIXTURE_HOST}:${address.port}/`,
    port: address.port,
    close() {
      if (!closePromise) closePromise = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
      return closePromise;
    },
  });
}

export function parseFixtureArguments(argv) {
  if (argv.length === 0) return { port: 0 };
  if (argv.length !== 2 || argv[0] !== "--port" || typeof argv[1] !== "string" || !PORT_PATTERN.test(argv[1])) {
    throw new Error("usage: gate4-fixture [--port <0..65535>]");
  }
  const port = Number(argv[1]);
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new Error("usage: gate4-fixture [--port <0..65535>]");
  }
  return { port };
}

export function fixtureReadyLine({ origin }) {
  if (typeof origin !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/u.test(origin)) {
    throw new TypeError("fixture origin is invalid");
  }
  return `gate4-fixture ready ${origin}/\n`;
}

async function main() {
  let options;
  try {
    options = parseFixtureArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const fixture = await createGate4FixtureServer(options);
  process.stdout.write(fixtureReadyLine(fixture));
  let closing;
  const stop = () => {
    if (!closing) closing = fixture.close().then(() => { process.exitCode = 0; });
    return closing;
  };
  process.once("SIGINT", () => { void stop(); });
  process.once("SIGTERM", () => { void stop(); });
  await new Promise((resolve) => {
    process.once("exit", resolve);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write("gate4-fixture failed\n");
    process.exitCode = 1;
  });
}
