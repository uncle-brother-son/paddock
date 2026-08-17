// default open-next.config.ts file created by @opennextjs/cloudflare
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import kvIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/kv-incremental-cache";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";

export default defineCloudflareConfig({
    // Enable KV caching for ISR
    incrementalCache: kvIncrementalCache,
    // Enable D1 tag cache for on-demand revalidation (revalidatePath/revalidateTag)
    tagCache: d1NextTagCache
});
