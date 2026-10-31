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

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
    for (const origin of [
        "https://openwebui.pollinations.ai",
        "https://openwebui.myceli.ai",
    ]) {
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
}
