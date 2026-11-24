import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { test } from "node:test";
import { verifyHealth, verifyRedirect } from "./verify.mjs";

test("health verification requires a successful, healthy JSON response", async () => {
    let status = 200;
    let body = JSON.stringify({ status: true });
    const server = createServer((_request, response) => {
        response.writeHead(status, { "Content-Type": "application/json" });
        response.end(body);
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const url = `http://127.0.0.1:${server.address().port}/health`;
    try {
        await verifyHealth(url);
        body = JSON.stringify({ status: false });
        await assert.rejects(verifyHealth(url), /unhealthy/);
        body = JSON.stringify({ status: true });
        status = 503;
        await assert.rejects(verifyHealth(url), /HTTP 503/);
        status = 200;
        body = "<html>Sign in</html>";
        await assert.rejects(verifyHealth(url), SyntaxError);
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test("cutover verification requires a permanent redirect preserving the deep link", async () => {
    let status = 301;
    let location = "https://openwebui.pollinations.app/c/example?source=legacy";
    const expected = location;
    const server = createServer((_request, response) => {
        response.writeHead(status, { Location: location });
        response.end();
    }).listen(0, "127.0.0.1");
    await once(server, "listening");
    const source = `http://127.0.0.1:${server.address().port}/c/example?source=legacy`;
    try {
        await verifyRedirect(source, expected);
        status = 308;
        await verifyRedirect(source, expected);
        status = 302;
        await assert.rejects(
            verifyRedirect(source, expected),
            /expected permanent redirect/,
        );
        status = 301;
        location = "https://openwebui.pollinations.app/";
        await assert.rejects(verifyRedirect(source, expected));
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});
