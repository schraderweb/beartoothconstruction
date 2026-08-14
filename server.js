const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");
const { randomUUID } = require("node:crypto");

const PORT = Number(process.env.PORT || 3000);
const ROOT = __dirname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

function loadEnv() {
  const envPath = path.join(ROOT, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equals = trimmed.indexOf("=");

    if (equals === -1) {
      continue;
    }

    const key = trimmed.slice(0, equals).trim();
    let value = trimmed.slice(equals + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

loadEnv();

function sendJson(response, status, body) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.end(JSON.stringify(body));
}

function safeJoin(root, requestedPath) {
  const resolved = path.resolve(root, "." + path.normalize(requestedPath));

  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    return null;
  }

  return resolved;
}

function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  let pathname = decodeURIComponent(url.pathname);

  if (pathname === "/") {
    pathname = "/index.html";
  }

  const filePath = safeJoin(ROOT, pathname);

  if (!filePath) {
    response.statusCode = 403;
    response.end("Forbidden");
    return;
  }

  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      response.statusCode = 404;
      response.end("Not Found");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    const mimeType = MIME_TYPES[extension] || "application/octet-stream";

    response.statusCode = 200;
    response.setHeader("Content-Type", mimeType);
    response.setHeader("Cache-Control", "no-store");
    fs.createReadStream(filePath).pipe(response);
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];

    request.on("data", (chunk) => {
      chunks.push(chunk);
    });

    request.on("end", () => {
      resolve(Buffer.concat(chunks));
    });

    request.on("error", reject);
  });
}

async function handleApi(request, response) {
  let handler;

  try {
    handler = require("./api/contact");
  } catch (error) {
    console.error("Unable to load api/contact.js", error);
    return sendJson(response, 500, { ok: false, message: "Server error." });
  }

  let body = {};

  if (request.method === "POST") {
    const rawBody = await readBody(request);
    const contentType = request.headers["content-type"] || "";

    if (contentType.includes("application/json")) {
      try {
        body = JSON.parse(rawBody.toString("utf8"));
      } catch (error) {
        body = {};
      }
    } else {
      body = rawBody.toString("utf8");
    }
  }

  request.body = body;

  const responseWrapper = {
    statusCode: 200,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
    },
    end(payload) {
      response.statusCode = this.statusCode;

      for (const [name, value] of Object.entries(this.headers)) {
        response.setHeader(name, value);
      }

      response.end(payload);
    },
  };

  try {
    await handler(request, responseWrapper);
  } catch (error) {
    console.error("api/contact.js failed", error);
    response.statusCode = 500;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.end(JSON.stringify({ ok: false, message: "Server error." }));
  }
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

  if (url.pathname === "/api/contact") {
    handleApi(request, response).catch((error) => {
      console.error("handleApi failed", error);
      response.statusCode = 500;
      response.end("Server error");
    });
    return;
  }

  serveStatic(request, response);
});

server.listen(PORT, () => {
  console.log(`Beartooth dev server running at http://localhost:${PORT}`);
});

module.exports = server;
