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
    assert.equal(response.status, 308, `${url}: expected a permanent redirect`);
    assert.equal(response.headers.get("location"), expectedLocation);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    const canonical = "https://openwebui.pollinations.app";
    const origins = [canonical, "https://openwebui.myceli.ai"];
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
    if (process.argv.includes("--redirect")) {
        const path = "/c/cutover-verification?source=legacy";
        await verifyRedirect(
            `https://openwebui.pollinations.ai${path}`,
            `${canonical}${path}`,
        );
        console.log("Verified the legacy hostname redirects with its path and query.");
    }
}
