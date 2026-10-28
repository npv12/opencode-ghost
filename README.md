# OpenCode Prompt Completion

An OpenCode V2 terminal and Desktop plugin that shows a grey continuation directly in the prompt
field. `Tab` accepts the whole continuation, `Option+→` on macOS or `Ctrl+→` on
Linux/Windows accepts the next word, and `Esc` hides the hint. Until you accept
it, the hint is not part of the prompt text, and messages are never sent
automatically.

**Automatic mode is on by default: drafts are sent to the selected model before
Enter and requests consume quota or paid tokens.** Set `automatic: false` for
manual-only requests; see [Configuration](#configuration).

## Requirements

- OpenCode V2 with the CLI plugin API. Renderer checks cover OpenCode
  `2.0.27` / OpenTUI `0.5.17` and OpenCode `2.1.0` / OpenTUI `0.6.6`.
- A configured provider and an available model in OpenCode.
- A current OpenCode V2 CLI with `opencode plugin add`.

The terminal part attaches through the global `cli.json`, including when you
work with a remote server. Desktop uses the global `opencode.json(c)` instead
and requires OpenCode `2.2.0` with its experimental GUI plugin API. OpenCode V1
is not supported.

## Installation

```sh
opencode plugin add github:pank-su/opencode-prompt-completion
```

OpenCode downloads the package and registers its CLI-only entry. No cloning,
separate installer, npm account or manual dependency installation is needed.
OpenCode supplies its plugin API and manages package dependencies, caching and updates.

You can also add the package directly to `~/.config/opencode/cli.json`
(or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "plugins": ["github:pank-su/opencode-prompt-completion"]
}
```

Merge the entry into your existing `plugins` array; do not replace other plugins.
Use `cli.json`, not `opencode.json`, so the plugin stays local with remote servers.
GitHub installation uses the repository; no npm release is required.

After installing, open a session, type at least three characters and leave the
cursor at the end. After a pause and a model response, grey text may appear. If
the plugin did not load into an already open TUI, use `/reload`.

When migrating from the old installer, replace its absolute-path plugin entry
with the GitHub package entry and carry over any `options`. Do not keep both
entries. Old release directories can remain on disk.

## Desktop installation

Add the package to `plugins` in the global `~/.config/opencode/opencode.json(c)`
(or `$XDG_CONFIG_HOME/opencode/opencode.json(c)`). A `cli.json` entry alone does
not load Desktop plugins. Merge this entry; preserve your other plugins:

```json
{
  "plugins": [{
    "package": "github:pank-su/opencode-prompt-completion",
    "options": {
      "promptCompletion": {
        "enabled": true,
        "automatic": true,
        "predictionModel": "openai/gpt-5.2#low",
        "timeoutMs": 7000
      }
    }
  }]
}
```

**Enabling automatic Desktop completion sends drafts to the model before Enter
and consumes quota or paid tokens.** Use a model available on the connected
server. Desktop is disabled by default; set `enabled: true` or use the
"Enable prompt completion" command. That command saves a window preference;
once saved, it takes precedence over the initial `enabled` option.

Desktop options are nested under `promptCompletion`, independently of the
terminal options in `cli.json`. The debounce, cooldown, timeout and automatic
options have the same defaults and ranges as the terminal. Desktop model
overrides accept a string `provider/model#variant` or the legacy object
`{ "providerID": "openai", "id": "gpt-5.2", "variant": "low" }`.
Without an override, Desktop follows the composer model and chooses an available
`none`, `minimal` or `low` variant without changing the main session model.

`Tab` accepts the hint, `Option+Right` / `Ctrl+Right` accepts one word, and `Esc`
hides it. `Cmd+Alt+J` / `Ctrl+Alt+J` requests a hint manually. The command palette
also provides "Desktop completion status" diagnostics. The hint never sends
the prompt, and accepting it uses native insertion to preserve mentions.

The GUI bundle is prebuilt in the repository: no local build is needed to
install it. This experimental adapter targets the Desktop `2.2.0` composer DOM;
unknown markup, IME, selections, native menus and a caret away from the end
disable hints. Its external overlay is hidden from accessibility APIs and is
not inserted into the editable text. It may need an update after Desktop
changes. Do not run this package's Desktop completion alongside the older
completion embedded in another plugin, or both may request and show hints.
This package does not migrate or disable that older plugin automatically.

## Updating

```sh
opencode plugin check
opencode plugin update github:pank-su/opencode-prompt-completion
```

To pin a revision, append `#<full-commit-hash>` to the GitHub package specifier.
Pinned revisions are not updated automatically by `plugin update`.

## Controls

| Action | Keys |
| --- | --- |
| Accept the whole continuation | `Tab` |
| Accept the next word | `Option+→` on macOS, `Ctrl+→` on Linux/Windows |
| Alternative word acceptance on macOS | `Option+F`, for terminals that send `Esc+f` |
| Hide the shown hint | `Esc` |
| Request a hint manually | `<leader>j`, or the "Suggest or complete the prompt" command palette entry |
| Open diagnostics | The "Completion status" command palette entry |

`Enter` and `Shift+Tab` keep their usual behaviour. With matching input,
Backspace and word-wise acceptance reuse the cached suffix without a new request.
A word is the fragment up to the next space, including a leading separator and
punctuation.

## Configuration

Use an object instead of the plugin string in `cli.json` to customize completion:

```json
{
  "package": "github:pank-su/opencode-prompt-completion",
  "options": {
    "automatic": true,
    "typingDebounceMs": 500,
    "cooldownMs": 1500,
    "timeoutMs": 7000,
    "predictionModel": "openai/gpt-5.2#low"
  }
}
```

| Option | Default | Range |
| --- | --- | --- |
| `automatic` | `true` | `true` or `false` |
| `typingDebounceMs` | `500` | 100–5000 ms |
| `cooldownMs` | `1500` | 0–10000 ms |
| `timeoutMs` | `7000` | 1000–15000 ms |
| `predictionModel` | Current prompt model | OpenCode `provider/model#variant` selector |

For slower providers, set `timeoutMs` to `15000`. Completion status shows the
configured timeout and a sanitized English error when a request fails. Increasing
the timeout changes client waiting only; provider-side cancellation is not guaranteed.

Set `automatic: false` for manual-only requests. The model above is an example;
use a provider, model and variant available in your OpenCode `/models` catalog.
As in [OpenCode model selection](https://opencode.ai/v2/docs/models), the model ID
may contain `/`, and `#variant` is optional. The `predictionModel` value can also
use OpenCode's expanded form:

```json
{
  "providerID": "openai",
  "model": "gpt-5.2",
  "variant": "low"
}
```

Without `predictionModel` (or with `null`), completion follows the prompt's model
and uses an available `minimal` or `low` variant. An explicit selector uses only
its own variant, or the model default if omitted; it never switches the main
session model. Providers and credentials stay in OpenCode's configuration.
Invalid selector syntax disables requests rather than falling back to a different
model. Unknown models or variants are rejected by OpenCode during generation.
The legacy object with `id` instead of `model` remains supported.
Reasoning variants are provider-specific: `low` does not turn reasoning off.
Use `#none` only when your model catalog exposes that variant.

### Disable

Remove the plugin with:

```sh
opencode plugin remove github:pank-su/opencode-prompt-completion
```

To disable it without removing its package entry, append
`"-panksup.prompt-completion"` after that entry in `plugins`.

## Data and limitations

- The plugin uses stateless `generate.text`, without creating sessions or
  calling tools.
- A request contains the draft and at most four recent user and assistant text
  messages. Tool output, reasoning, system instructions, images and file
  attachments are not added separately. Text already included in a normal
  message may still enter the context.
- The context is limited to 10000 UTF-16 units and the whole prompt to 13000
  UTF-16 units. Reduction keeps the JSON valid.
- The plugin keeps no log of drafts or responses. This is not a guarantee that
  OpenCode or the provider does not log. The plugin cache is in memory: up to 16
  contexts of 32 candidates each.
- At most one client request is in flight at a time. A timeout and cancellation
  do not guarantee that the provider stops generating and charging tokens.
- Commands (`/…`, `!…`), child sessions and drafts longer than 2000 UTF-16 units
  are not completed. The prompt needs focus, no selection and the cursor at the
  end.
- Losing focus, shell mode or an open autocomplete menu hides the hint. An
  incomplete reply from a running agent is not included in the context.
- `null`, an error or hiding with `Esc` never triggers automatic retries for the
  same draft. A prediction may be unavailable.

## Architecture

- `tui.ts` — discovery entry and OpenCode-owned renderer/reactivity imports.
- `src/tui.ts` — the plugin implementation and lifecycle wiring.
- `src/prediction/` — the prediction core: controller, prompt and context
  building, word chunking.
- `src/editor/` — the editor adapter and the inline ghost renderer.
- `src/opencode/` — OpenCode integration: options, scheduler, commands and
  snapshot.
- `src/desktop/` — Desktop lifecycle, native insertion and read-only DOM adapter.
- `dist/gui-experimental.cjs` — prebuilt Desktop bundle using the same prediction core.

## Development

Requires Node.js `26.4.0+` and Bun `1.3.14`.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run check
```

`check` builds the Desktop bundle and runs Node, TUI renderer, Desktop DOM tests
and both TypeScript checks. Commit the generated GUI bundle with source changes.
The tests use a
stub model and the real native textarea and need no API keys. GitHub Actions
checks both renderer generations on Ubuntu, macOS and Windows; Desktop checks
run with the current SDK only. A workflow's
presence does not replace its actual result or a native OpenCode TUI smoke test.

## License

[MIT](LICENSE). The author of this implementation is
[pank-su](https://github.com/pank-su). This is an independent plugin, not an
official OpenCode component. OpenCode, OpenTUI and SolidJS retain their own
copyrights and licenses; their source and binaries are not vendored here.
