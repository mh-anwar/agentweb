---
title: Configuring the CLI
description: Every option the widget CLI reads, where it reads them from, and in which order.
sidebar_position: 3
---

# Configuring the CLI

![Architecture diagram](./img/config-flow.png)

The CLI reads configuration from **three places**, in this order (later wins):

1. A `widget.config.ts` file in the project root
2. Environment variables prefixed with `WIDGET_`
3. Command-line flags, e.g. `--port 8080`

> [!NOTE]
> Flags always win. If you set `WIDGET_PORT=3000` *and* pass `--port 8080`, the server listens on 8080.

Quick start
-----------

Create the file and export a config object:

```ts title="widget.config.ts"
import { defineConfig } from 'widget';

export default defineConfig({
  port: 8080,
  plugins: [react()],
});
```

## Options

| Option | Type | Default | Description |
|:-------|:----:|--------:|-------------|
| `port` | `number` | `5173` | Port for the dev server |
| `host` | `string \| boolean` | `'localhost'` | Set to `true` to listen on all addresses |
| `cache` | `false \| CacheOptions` | see [caching](#caching) | Disable or tune the build cache |

### Plugins

Plugins run in two phases:

- **Build** plugins:
  - transform source files
  - can emit extra assets, for example:

    ```js
    this.emitFile({ type: 'asset', fileName: 'robots.txt', source: '' });
    ```
- **Serve** plugins
  run only in development and may add middleware.

  They receive the dev server instance as their second argument.

* [ ] Document plugin ordering
* [x] Document plugin hooks

3. Install the plugin
4. Add it to `plugins`

### Caching

The cache lives in `node_modules/.widget`. See the [cache guide][cache] or the
[FAQ] for details, or open <https://widget.dev/issues>.
Bare links like https://widget.dev/changelog also work.

    widget --force   # rebuild ignoring the cache

<details>
<summary>Advanced: sharing the cache in CI</summary>

Point `cacheDir` at a directory your CI restores between runs.

</details>

<!-- TODO: document remote caching -->

Snake_case_names and 2 * 3 = 6 stay intact; __bold__ and ~~strike~~ do not.  
Escaped \*stars\* stay.

[cache]: https://widget.dev/guide/cache "Cache guide"
[faq]: /docs/faq
