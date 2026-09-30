+# Auto-Continue
+
+A DeepSeek Harness (DSH) plugin that automatically sends `continue` after supported failures. It handles rate limits, quota exhaustion, and configurable error codes.
+
+## Features
+
+| Feature | Behavior |
+|---|---|
+| Automatic continue | Sends a new `continue` message after the current turn ends with a matching error |
+| Built-in errors | Always handles DSH error codes `RATE_LIMIT` and `QUOTA` |
+| Output limit recovery | Automatically continues turns ending with the DSH reason `max-tokens` |
+| Thinking-mode 400 fix | Handles `invalid_request_error` by default, including missing `reasoning_content` errors |
+| Custom error codes | Add or remove extra codes from Settings, separated by commas or new lines |
+| Quick switch | An On/Off control appears beside the chat composer |
+| Master switch | Disables the whole plugin and hides the quick switch |
+| Per-session counting | Each conversation has its own consecutive-failure count |
+| Automatic reset | A successful turn resets that session; manually sending a message resets all counts |
+| Retry delay | Waits a random 1 to 2 seconds before sending `continue` |
+| Persistent settings | Saves settings in `~/.dsh/auto-continue-429.json` |
+
+Automatic continue runs only when both `enabled` and `quickOn` are true. The two switches are independent.
+
+## Local installation
+
+Extract this package, then run:
+
+```bash
+cd ~/.dsh/profiles/web
+pnpm link /path/to/dsh-auto-continue-429
+```
+
+Add `"dsh-auto-continue-429"` to the `dsh.profile.bundles` array in `~/.dsh/profiles/web/package.json`, then restart DSH Desktop.
+
+## Settings
+
+Open DSH Settings and select **Auto-Continue**.
+
+| Setting | Purpose |
+|---|---|
+| Enable plugin | Master switch for all automatic-continue behavior |
+| Consecutive failure limit | Stops after 1 to 100 matching failures; default is 20 |
+| Additional auto-continue error codes | Accepts codes separated by commas or new lines |
+
+`invalid_request_error` is included by default. `RATE_LIMIT` and `QUOTA` are built in and remain active even if the custom-code field is empty.
+
+The output-token-limit notice is built in too. DSH records it as `max-tokens`, so no custom error code is needed.
+
+## Error matching
+
+The plugin checks the normalized DSH code for `RATE_LIMIT` or `QUOTA`, then searches the complete error object for configured custom codes. This thinking-mode response is therefore matched:
+
+```text
+400: {
+  "message": "The `reasoning_content` in the thinking mode must be passed back to the API.",
+  "type": "invalid_request_error",
+  "code": "invalid_request_error"
+}
+```
+
+When matched, it waits 1 to 2 seconds and sends `continue`. It repeats until a turn succeeds, you intervene manually, or the configured failure limit is reached.
+
+## Optional configuration
+
+```yaml
+- id: auto-continue-429
+  name: dsh-auto-continue-429
+  config:
+    maxRetries: 20
+    continueMessage: "continue"
+    errorCodes:
+      - invalid_request_error
+```
+
+The plugin does not read API keys or send data to external services. Its HTTP routes use DSH's local web server.
+
+## License
+
+MIT © 2026
