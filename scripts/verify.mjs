import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";

export async function verifyHealth(url) {
    const response = await fetch(url, {
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
    });
    assert.equal(response.status, 200, `${url}: HTTP ${response.status}`);
    assert.equal((await response.json()).status, true, `${url}: unhealthy`);
}

export async function verifyRedirect(url, expectedLocation) {
    const response = await fetch(url, {
        redirect: "manual",
        signal: AbortSignal.timeout(15_000),
    });
    assert.ok(
        response.status === 301 || response.status === 308,
        `${url}: expected permanent redirect, got HTTP ${response.status}`,
    );
    assert.equal(response.headers.get("location"), expectedLocation);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const canonical = "https://openwebui.pollinations.app";
    const publicOrigin = process.argv.includes("--legacy")
        ? "https://openwebui.pollinations.ai"
        : canonical;
    const origins = [publicOrigin, "https://openwebui.myceli.ai"];
    for (const origin of origins) {
        for (const path of ["/health", "/health/db"]) {
            const url = `${origin}${path}`;
            for (let attempt = 1; ; attempt++) {
                try {
                    await verifyHealth(url);
                    console.log(`Healthy: ${url}`);
                    break;
                } catch (error) {
                    if (attempt === 12) throw error;
                    await new Promise((resolve) => setTimeout(resolve, 5_000));
                }
            }
        }
    }
    if (process.argv.includes("--cutover")) {
        const path = "/c/cutover-verification?source=legacy";
        await verifyRedirect(
            `https://openwebui.pollinations.ai${path}`,
            `${canonical}${path}`,
        );
        console.log("Verified permanent redirect from the old hostname.");
    }
}
